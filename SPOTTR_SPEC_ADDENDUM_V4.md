# SPOTTR — Spec Addendum V4 (Replaces V3)

This addendum extends V3 with three things:
1. **Complete keys inventory** confirming what's integrated and what's still needed
2. **The competitive blindspot** (Google/Apple) and how to make the dataset hard to replicate
3. **The cheap-build playbook** — how to reach all-Connecticut coverage on <$50 total

V4 keeps everything from V3 intact. The geographic phase plan, batch pipeline, search-first UX, and two-pass spot detection all stand. This adds the strategic + budget context.

---

## 1. Keys & accounts inventory (current state)

### ✅ Already integrated and working

| Service | Key | Used for |
|---|---|---|
| Google Maps Static API | `REDACTED_GOOGLE_KEY_1` | Aerial tile fetching for YOLOv8 (use sparingly — see cheap build) |
| Mapbox | `pk.eyJ1Ijoic29oYW05ODk...` | In-app map display + live sat toggle |
| Mapillary | `REDACTED_MAPILLARY_TOKEN` | Street-level sign/restriction extraction |
| AWS | Account confirmed | S3 tile cache (need to create `spottr-imagery` bucket + IAM key) |
| Railway | Account + Postgres + Redis live | Backend hosting + DB + job queue |
| Expo | Project: Scattr / Account: Coder 119 | React Native push notifications |
| OpenStreetMap (Overpass) | No key needed | Free polygon/lot ingestion |
| Hartford Open Data | No key needed | Free Socrata API for Hartford-specific data |
| USGS/NAIP | EarthExplorer account (free signup) | **Primary imagery source for the pipeline** — see section 3 |

### ⚠️ New API to enable (no new key needed)

**Google Places API** — needed for business name search ("BJ's" lookup). Enable it on your **existing Google Cloud project**:

1. Google Cloud Console → APIs & Services → Library
2. Search "Places API" → click → **Enable**
3. The existing `AIzaSyAY3aW3vd3g...` key now works for Places too

Make sure to restrict the key by HTTP referrer (your app's bundle ID) in the console to prevent abuse.

### 💰 Budget warning on Google Places

Google Places pricing:
- Autocomplete: **$2.83 per 1,000 calls** after free tier
- Place Details: **$17 per 1,000 calls** after free tier
- Free tier: $200/month credit (≈ 10–15k searches/month)

This is fine for dev and MVP launch, but is the single biggest variable cost at scale. See **Nominatim fallback** below.

### 🆓 Free alternative for search: Nominatim

Nominatim is OpenStreetMap's geocoder. Free, no key required, business name search works.

- Public API: rate-limited to 1 req/sec per IP (fine for dev)
- Self-hosted: deploy on Railway as a separate service, unlimited requests, $0 ongoing cost
- Trade-off vs Google Places: less polished autocomplete UX, but covers 95% of search needs

**Recommended strategy:**
- Development & MVP testing → Nominatim (public or self-hosted)
- Production launch → Google Places, with a daily quota cap to prevent surprise bills
- Long term → Self-hosted Nominatim primary, Google Places as fallback for low-confidence results

### ❌ Skipped (not needed for current phases)

| Service | Why skipped |
|---|---|
| Nearmap | Mapbox satellite tiles cover the in-app display use case for free |
| BlackSky | On-demand tasking is an enterprise-tier feature — revisit post-funding |
| Maxar/Vantor | Same as BlackSky |

---

## 2. The competitive blindspot + defensibility playbook

### The real threat is not a startup — it's Google or Apple

Any indie builder making a "parking app" loses. The actual risk is one of two scenarios:

1. **Google decides to ship parking occupancy in Google Maps.** They have the imagery (already 30cm globally), the place database (every business on earth), the compute, and a billion daily users. If they prioritize this feature, a startup competing on the same axis cannot win on resources.

2. **Apple ships it in Apple Maps.** Same problem, smaller user base, but tighter iOS integration.

The good news: **neither has prioritized this in over a decade.** Google has shipped vague "Find parking" features that surface garage listings — they've never built spot-level occupancy. Apple has done nothing in this category. The category has been ignored because for a horizontal mapping product, parking is a niche feature, not a wedge.

That window is what you're building inside of.

### The four-layer defensibility strategy

Making this hard to replicate requires building four moats that compound on each other. No single one is enough; all four together make replication impractical even for Google.

**Moat 1: Temporal pattern data (the clock moat)**

A geocoded lot polygon is replicable in a week. An 18-month history of how each spot's occupancy varies by hour, day-of-week, weather, and local events is *not* replicable in a week. It requires running the pipeline continuously starting now.

Every month you operate, this gap widens. By month 18, even if Google decides to build this, they'd need 18 months of pipeline runs to catch up — or they'd need to buy the dataset from you.

**Schema implication:** every spot detection writes to an `occupancy_history` table indexed by `(lot_id, space_id, timestamp)`. Even if you don't use this data for the MVP, accumulating it from day one is the moat being built.

```sql
CREATE TABLE occupancy_history (
    id BIGSERIAL PRIMARY KEY,
    space_id INT REFERENCES spaces(id),
    lot_id INT REFERENCES lots(id),
    occupied BOOLEAN NOT NULL,
    confidence FLOAT,
    source VARCHAR(20),  -- 'yolo' | 'gps' | 'camera' | 'crowdsourced'
    captured_at TIMESTAMP NOT NULL,
    weather_conditions JSONB,
    nearby_events JSONB
);
CREATE INDEX idx_occupancy_history_time ON occupancy_history(space_id, captured_at);
```

Start writing to this table on the very first pipeline run, even if nothing queries it yet.

**Moat 2: Unified schema across fragmented sources (the integration moat)**

OSM has polygons. Cities have transaction data. NAIP has imagery. Mapillary has signs. Each is public and free. **Unifying them into one normalized, geocoded schema is the actual work**, and the work compounds — every city you integrate makes the next city faster, because the schema and tooling already exist.

Google won't do this work because they don't normalize disparate municipal data sources. Their data philosophy is "we collect our own." Your moat is being the one player willing to do the boring schema work across 1000+ municipal data sources.

**Implementation:** every new city scraper writes to the same `lots`, `spaces`, `rates` tables. Standardize field names. Make `data_sources` a JSONB column on each lot that tracks provenance. By the time you've integrated 50 cities, your data normalization layer is itself an asset.

**Moat 3: Passive crowdsourced refresh (the user moat — earned later)**

Once users exist, their phones become free occupancy sensors. Every drive logs which spots were occupied/freed. Over 100k users, this becomes more current than satellite imagery could ever be.

Critically — and this is where it gets defensible — **the historical occupancy data + current crowdsourced refresh together** is a closed feedback loop:
- Historical patterns predict where to look
- Crowdsourced data validates and refines predictions
- Refined predictions train better models
- Better models attract more users
- More users generate more crowdsourced data

Google has user GPS data via Waze and Maps but doesn't use it for individual spot occupancy. By the time they care enough to repurpose it, you have 2+ years of head start on the inference layer.

**Moat 4: Velocity (the speed moat)**

The single most underestimated moat: just move faster than they bother. Google has 50,000 priorities. Parking is #847 on the list. You have one priority. By the time Google's parking team gets staffed and ships v1, you can be on v8 with continental US coverage.

Translation: **don't waste time building beautiful product polish before the dataset is wide.** Every hour spent on UI polish at phase 2 is an hour not spent expanding to phase 3. The dataset is the moat. The app is just the demo.

### What this means in practice for your build

Three concrete actions Claude Code should bake into the architecture starting now:

1. **Write to `occupancy_history` from day one** even if no UI surfaces it. The historical record IS the moat. Don't wait until "the app needs it" — by then it's too late.

2. **Track `data_sources` provenance in every row.** A JSONB column on `lots`, `spaces`, and `rates` that records: OSM way ID, Hartford GIS record ID, NAIP tile ID, YOLO model version, etc. This makes the unified schema visibly proprietary and acquisition-ready (a buyer can see exactly what fragmented sources you've integrated).

3. **Add an `accumulation_metrics` admin endpoint.** Returns total lots covered, total spaces geocoded, total occupancy observations recorded, growth rate per week. **This is the dataset growing in real time** — it's the chart you show every investor and every acquirer. Make the number go up.

```sql
-- Add to migration
ALTER TABLE lots ADD COLUMN data_sources JSONB DEFAULT '[]';
ALTER TABLE spaces ADD COLUMN data_sources JSONB DEFAULT '[]';
ALTER TABLE lots ADD COLUMN first_observed_at TIMESTAMP DEFAULT NOW();
```

```python
# routes/admin.py
@router.get("/admin/accumulation-metrics")
async def accumulation_metrics():
    return {
        "lots_total": db.query(Lot).count(),
        "lots_with_spaces": db.query(Lot).filter(Lot.spot_detection_status == 'complete').count(),
        "spaces_total": db.query(Space).count(),
        "occupancy_observations_total": db.query(OccupancyHistory).count(),
        "growth_last_7_days": {
            "lots": db.query(Lot).filter(Lot.first_observed_at > now - 7d).count(),
            "spaces": db.query(Space).filter(Space.created_at > now - 7d).count(),
            "observations": db.query(OccupancyHistory).filter(OccupancyHistory.captured_at > now - 7d).count(),
        }
    }
```

This is your investor pitch in one endpoint.

---

## 3. The cheap-build playbook (Phases 1–3 on under $50)

The geographic phase plan from V3 assumed Google Maps Static API costs. Those numbers were conservative. Here's the actually-cheap path that reaches **all of Connecticut for under $50 total**.

### The single biggest cost lever: use NAIP imagery instead of Google Maps Static

The pipeline doesn't actually need Google Maps tiles. **NAIP (National Agriculture Imagery Program)** is free public aerial imagery from the USGS covering the entire continental US at 1-meter resolution. That's sharp enough for YOLOv8 vehicle detection and works fine for stripe segmentation in well-marked lots.

**How to use it:**

1. Create a free USGS EarthExplorer account: https://earthexplorer.usgs.gov/
2. Download NAIP tiles by state — Connecticut is one bulk download, ~15GB
3. Store in your existing AWS S3 bucket (`spottr-imagery`)
4. Pipeline reads from S3 instead of hitting Google Maps Static API

**Cost comparison for all of CT (~80,000 lots):**
- Google Maps Static API: ~$300
- NAIP via USGS: **$0** (free download) + ~$1/month S3 storage

Drop in replacement. The pipeline code change is just swapping the tile fetcher:

```python
# pipeline/utils/imagery.py

# OLD (paid Google Maps)
def get_aerial_tile(lat, lng, zoom=20):
    url = (f"https://maps.googleapis.com/maps/api/staticmap"
           f"?center={lat},{lng}&zoom={zoom}&size=640x640"
           f"&maptype=satellite&key={GOOGLE_MAPS_KEY}")
    return requests.get(url).content

# NEW (free NAIP from S3)
def get_aerial_tile(lat, lng, zoom_equivalent=20):
    # NAIP tiles are 1m resolution geotiffs, organized by quadrangle
    quad_id = naip_quadrangle_for(lat, lng)
    tile = s3.get_object(Bucket='spottr-imagery', Key=f'naip/ct/{quad_id}.tif')
    return crop_to_lat_lng(tile, lat, lng, size_meters=200)
```

Reserve the Google Maps Static API for edge cases: lots where NAIP imagery is older than 2 years, or specific cases where 30cm Google is meaningfully sharper than 1m NAIP. Cap monthly Google Maps spend at $20.

### The second-biggest cost lever: free GPU compute

Don't pay for cloud GPUs for Phase 2-3. YOLOv8 inference is fast and these scales are small enough for free tier compute.

**Recommended options:**

1. **Google Colab free tier** — T4 GPU, 12-hour session limits. Connect to your Railway DB and S3 bucket. Run batches overnight. **Cost: $0.**
2. **Kaggle Notebooks** — P100 GPU, 30 hours/week free. Same setup. **Cost: $0.**
3. **Your own laptop** — slower but free. Fine for Hartford metro overnight runs.
4. **Modal/RunPod free credit** — $30 free credit each on signup. Use only for time-pressured batches.

For ~5,000 Hartford lots (Phase 2), one Colab session does it. For ~80,000 CT lots (Phase 3), 1–2 weeks of nightly Colab runs.

### The third lever: stay on Railway free/cheap tiers

Railway pricing for what you actually need:
- **Free trial:** $5 credit (already used for Postgres + Redis setup)
- **Hobby plan:** $5/month + usage. For Phase 1–3 scale, total bill is ~$10–20/month.

Phase 4 (Northeast US) will need to upgrade to Pro tier (~$20/month) with read replicas. That's still trivial cost.

### Phase-by-phase realistic budget

| Phase | Coverage | Imagery | Compute | Hosting | **Total** |
|---|---|---|---|---|---|
| 1 ✅ Hartford downtown (551 lots) | done | NAIP free | laptop | Railway free trial | **$0** |
| 2 Greater Hartford metro (~5k lots) | this week | NAIP free | Colab free | Railway $10/mo | **$10** |
| 3 All Connecticut (~80k lots) | 2–3 weeks | NAIP free | Colab + Kaggle free | Railway $20/mo | **~$40** |
| 4 Northeast US (~1.5M lots) | 1–2 months | NAIP free | RunPod $200 + Colab | Railway $80/mo | **~$400** |
| 5 Continental US (~40M lots) | 6–9 months | NAIP free + targeted Google Maps | dedicated GPU workers | Railway Pro $200/mo | **~$3,000** |

**Phase 5 dropped from ~$160k to ~$3,000** because NAIP coverage means imagery is free for the entire CONUS. The previous estimate assumed paid Google Maps Static tiles for the full pipeline, which isn't necessary.

The only real Phase 5 cost is GPU compute time for processing 40M lots through the YOLOv8 + SAM pipeline. At ~10 lots/second per GPU on RunPod ($0.40/hour for an A4000), that's ~$3,000 for the full US.

**This means continental US coverage is buildable for low four figures of compute spend, not a seed round.** That changes everything strategically — you may be able to self-fund through Phase 5 if you commit the time.

### Where the previous estimates were too pessimistic

V3's Phase 5 estimate was $160k. The real number is closer to $3k. The mistake was assuming Google Maps Static API tile costs across 40M lots. Once NAIP is the primary imagery source, the cost collapses to mostly compute time.

This is the kind of finding that makes a side project viable. **You can plausibly build the continental US dataset on your own dime over 6–9 months without raising any money.** That's a different game than I framed in V3.

---

## 4. Updated Claude Code task list

After V3's tasks (1–6), add these to the same session:

7. **Switch the pipeline's imagery source from Google Maps Static to NAIP.** Add a NAIP download script that fetches CT tiles to S3. Update `pipeline/utils/imagery.py` to read from S3 by default with Google Maps as fallback.

8. **Add `occupancy_history` table** with the schema above. Wire pipeline 03 to write a row on every detection (occupied or not).

9. **Add `data_sources` JSONB column** to lots, spaces, rates. Populate it as each pipeline step touches a record.

10. **Build the `/admin/accumulation-metrics` endpoint** so the dataset growth is visible and screenshot-able.

11. **Enable Places API** on the existing Google Cloud key (no new key needed) AND add a Nominatim fallback service definition for the Railway project.

---

## Strategic bottom line (updated from V3)

V3 said the dataset moat is the strategy. V4 confirms: **the dataset moat is the strategy, it's cheaper to build than I estimated, and the defensibility comes from four compounding moats (temporal patterns, unified schema, crowdsourced refresh, velocity) — not from any single technical innovation.**

The order matters:

1. **Get the dataset wide first** (continental US coverage) — buildable for ~$3k
2. **Get historical occupancy deep** (12+ months of patterns) — built passively as you operate
3. **Then add users** for crowdsourced refresh — the user layer becomes the third moat
4. **Then add product polish** — the app polish is the *last* thing to perfect, not the first

You're at step 1, phase 1. The next 6–9 months are the moat-building period.
