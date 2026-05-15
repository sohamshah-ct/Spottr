"""
SPOTTR Pipeline 05 — Occupancy Prediction Model
Uses Prophet time-series to predict hourly occupancy per lot.
Falls back to pattern-based predictions when no historical data exists.

Usage:
  python pipeline/05_occupancy_model.py --city Hartford
  python pipeline/05_occupancy_model.py --retrain-all
"""

import os
import sys
import json
import math
import argparse
from datetime import datetime, timedelta
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../backend/.env'))

DATABASE_URL = (
    os.environ.get('DATABASE_PUBLIC_URL') or
    os.environ.get('DATABASE_URL', '')
)
if 'railway.internal' in DATABASE_URL:
    raise RuntimeError("Use: railway run python pipeline/05_occupancy_model.py")

MODEL_VERSION = "v1.0-pattern"


# Typical occupancy patterns by hour (0-23) for different lot types
# Values 0.0-1.0 represent occupancy fraction
TYPICAL_PATTERNS = {
    'surface': {
        # Weekday (Mon-Fri)
        'weekday': [
            0.05, 0.05, 0.05, 0.05, 0.08, 0.15,  # 0-5am
            0.30, 0.60, 0.80, 0.85, 0.85, 0.85,  # 6-11am
            0.90, 0.85, 0.80, 0.75, 0.65, 0.55,  # 12-5pm
            0.40, 0.30, 0.20, 0.15, 0.10, 0.05,  # 6-11pm
        ],
        # Weekend (Sat-Sun)
        'weekend': [
            0.05, 0.05, 0.05, 0.05, 0.05, 0.05,  # 0-5am
            0.10, 0.20, 0.35, 0.50, 0.65, 0.75,  # 6-11am
            0.80, 0.80, 0.75, 0.70, 0.60, 0.50,  # 12-5pm
            0.35, 0.25, 0.15, 0.10, 0.08, 0.05,  # 6-11pm
        ],
    },
    'garage': {
        'weekday': [
            0.10, 0.08, 0.07, 0.07, 0.10, 0.20,
            0.45, 0.70, 0.85, 0.90, 0.92, 0.90,
            0.88, 0.85, 0.83, 0.78, 0.65, 0.50,
            0.35, 0.25, 0.18, 0.15, 0.12, 0.10,
        ],
        'weekend': [
            0.08, 0.06, 0.05, 0.05, 0.05, 0.08,
            0.12, 0.25, 0.40, 0.55, 0.68, 0.78,
            0.82, 0.82, 0.78, 0.72, 0.62, 0.52,
            0.40, 0.30, 0.20, 0.15, 0.12, 0.08,
        ],
    },
    'street': {
        'weekday': [
            0.02, 0.02, 0.02, 0.02, 0.05, 0.15,
            0.40, 0.70, 0.85, 0.88, 0.88, 0.88,
            0.90, 0.88, 0.85, 0.80, 0.70, 0.55,
            0.40, 0.30, 0.20, 0.12, 0.06, 0.03,
        ],
        'weekend': [
            0.02, 0.02, 0.02, 0.02, 0.02, 0.05,
            0.10, 0.20, 0.38, 0.55, 0.68, 0.78,
            0.82, 0.82, 0.78, 0.72, 0.65, 0.55,
            0.42, 0.32, 0.22, 0.14, 0.08, 0.04,
        ],
    },
}


def try_prophet_model(cur, lot_id):
    """Try to train a Prophet model if historical events exist. Returns forecast df or None."""
    try:
        import pandas as pd
        from prophet import Prophet

        cur.execute("""
            SELECT
                date_trunc('hour', observed_at) AS ds,
                COUNT(*) FILTER (WHERE event_type = 'arrived') AS arrived,
                COUNT(*) FILTER (WHERE event_type = 'departed') AS departed
            FROM occupancy_events
            WHERE lot_id = %s
            GROUP BY 1
            ORDER BY 1
        """, (lot_id,))
        rows = cur.fetchall()

        if len(rows) < 48:  # Need at least 48 hours of data
            return None

        df = pd.DataFrame(rows, columns=['ds', 'arrived', 'departed'])
        df['ds'] = pd.to_datetime(df['ds'])
        df['y'] = (df['arrived'] / (df['arrived'] + df['departed'] + 1)).clip(0, 1)

        model = Prophet(
            yearly_seasonality=False,
            weekly_seasonality=True,
            daily_seasonality=True,
        )
        model.fit(df[['ds', 'y']])
        future = model.make_future_dataframe(periods=168, freq='h')
        forecast = model.predict(future)
        return forecast[['ds', 'yhat', 'yhat_lower', 'yhat_upper']].tail(168)

    except ImportError:
        return None
    except Exception:
        return None


def generate_pattern_predictions(lot, now):
    """Generate 168 hours of predictions using typical patterns."""
    lot_type = lot.get('lot_type') or 'surface'
    if lot_type not in TYPICAL_PATTERNS:
        lot_type = 'surface'

    patterns = TYPICAL_PATTERNS[lot_type]
    total_spaces = lot.get('total_spaces') or 50  # default if unknown

    predictions = []
    for hour_offset in range(168):  # 7 days
        dt = now + timedelta(hours=hour_offset)
        day_of_week = dt.weekday()  # 0=Mon, 6=Sun
        hour = dt.hour
        is_weekend = day_of_week >= 5

        pattern = patterns['weekend'] if is_weekend else patterns['weekday']
        base_occ = pattern[hour]

        # Add small random variation (+/- 5%)
        import random
        variation = random.uniform(-0.05, 0.05)
        occupancy = max(0.0, min(1.0, base_occ + variation))
        open_spaces = max(0, int(total_spaces * (1 - occupancy)))

        predictions.append({
            'lot_id': lot['id'],
            'predicted_for': dt.isoformat(),
            'day_of_week': day_of_week,
            'occupancy_pct': round(occupancy, 3),
            'open_spaces': open_spaces,
            'model_version': MODEL_VERSION,
        })

    return predictions


def write_predictions(cur, predictions):
    """Upsert predictions into predictions table."""
    if not predictions:
        return
    psycopg2.extras.execute_batch(cur, """
        INSERT INTO predictions (lot_id, predicted_for, day_of_week,
                                 occupancy_pct, open_spaces, model_version)
        VALUES (%(lot_id)s, %(predicted_for)s::timestamptz, %(day_of_week)s,
                %(occupancy_pct)s, %(open_spaces)s, %(model_version)s)
        ON CONFLICT DO NOTHING;
    """, predictions, page_size=500)


def seed_occupancy_snapshot(cur, lot):
    """Create an initial occupancy snapshot for a lot based on current predicted occupancy."""
    now = datetime.utcnow()
    hour = now.hour
    day_of_week = now.weekday()
    lot_type = lot.get('lot_type') or 'surface'
    if lot_type not in TYPICAL_PATTERNS:
        lot_type = 'surface'
    pattern = TYPICAL_PATTERNS[lot_type]
    is_weekend = day_of_week >= 5
    occupancy = pattern['weekend' if is_weekend else 'weekday'][hour]

    total_spaces = lot.get('total_spaces') or 50
    total_open = max(0, int(total_spaces * (1 - occupancy)))

    # Build row snapshots from lot_rows
    cur.execute("""
        SELECT label, space_count, position_order FROM lot_rows
        WHERE lot_id = %s ORDER BY position_order
    """, (lot['id'],))
    rows = cur.fetchall()

    row_snapshots = {}
    for r in rows:
        label = r['label'] if isinstance(r, dict) else r[0]
        space_count = r['space_count'] if isinstance(r, dict) else r[1]
        pos_order = int((r['position_order'] if isinstance(r, dict) else r[2]) or 1)
        sc = space_count or max(1, total_spaces // max(1, len(rows)))
        row_occ = min(1.0, occupancy * (1 + 0.1 * (pos_order - 1)))  # further rows slightly fuller
        row_open = max(0, int(sc * (1 - row_occ)))
        row_snapshots[label] = {
            'open': row_open,
            'total': sc,
            'confidence': 'estimated',
        }

    cur.execute("""
        INSERT INTO occupancy_snapshots
            (lot_id, row_snapshots, total_open, total_spaces, occupancy_pct,
             last_updated, data_age_mins, confidence)
        VALUES (%s, %s::jsonb, %s, %s, %s, NOW(), 0, 'estimated')
        ON CONFLICT (lot_id) DO UPDATE SET
            row_snapshots  = EXCLUDED.row_snapshots,
            total_open     = EXCLUDED.total_open,
            total_spaces   = EXCLUDED.total_spaces,
            occupancy_pct  = EXCLUDED.occupancy_pct,
            last_updated   = NOW(),
            data_age_mins  = 0,
            confidence     = 'estimated';
    """, (lot['id'], json.dumps(row_snapshots), total_open, total_spaces,
          round(occupancy, 3)))


def run(city=None, retrain_all=False, limit=500):
    conn = psycopg2.connect(DATABASE_URL, sslmode='require')
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    query = "SELECT * FROM lots WHERE lat IS NOT NULL"
    params = []
    if city:
        query += " AND city ILIKE %s"
        params.append(f'%{city}%')
    if not retrain_all:
        # Only lots without predictions yet
        query += """ AND id NOT IN (
            SELECT DISTINCT lot_id FROM predictions WHERE lot_id IS NOT NULL
        )"""
    query += " ORDER BY total_spaces DESC NULLS LAST LIMIT %s"
    params.append(limit)

    cur.execute(query, params)
    lots = [dict(r) for r in cur.fetchall()]

    print(f"Generating predictions for {len(lots)} lots...")
    now = datetime.utcnow().replace(minute=0, second=0, microsecond=0)

    processed = 0
    for lot in lots:
        # Try Prophet first, fall back to patterns
        forecast = try_prophet_model(cur, lot['id'])

        if forecast is not None:
            total_spaces = lot.get('total_spaces') or 50
            predictions = []
            for _, row in forecast.iterrows():
                occ = max(0.0, min(1.0, float(row['yhat'])))
                predictions.append({
                    'lot_id': lot['id'],
                    'predicted_for': row['ds'].isoformat(),
                    'day_of_week': row['ds'].weekday(),
                    'occupancy_pct': round(occ, 3),
                    'open_spaces': max(0, int(total_spaces * (1 - occ))),
                    'model_version': 'prophet-v1',
                })
        else:
            predictions = generate_pattern_predictions(lot, now)

        write_predictions(cur, predictions)
        seed_occupancy_snapshot(cur, lot)
        processed += 1

        if processed % 50 == 0:
            conn.commit()
            print(f"  {processed}/{len(lots)} lots done...")

    conn.commit()

    cur.execute("SELECT COUNT(*) FROM predictions")
    pred_count = cur.fetchone()['count']
    cur.execute("SELECT COUNT(*) FROM occupancy_snapshots")
    snap_count = cur.fetchone()['count']

    cur.close()
    conn.close()

    print(f"OK Predictions generated for {processed} lots")
    print(f"OK {pred_count} prediction records in DB")
    print(f"OK {snap_count} occupancy snapshots seeded")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--city', default='Hartford')
    parser.add_argument('--retrain-all', action='store_true')
    parser.add_argument('--limit', type=int, default=500)
    args = parser.parse_args()
    run(city=args.city, retrain_all=args.retrain_all, limit=args.limit)
