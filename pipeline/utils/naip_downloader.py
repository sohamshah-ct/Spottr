"""
pipeline/utils/naip_downloader.py
Downloads NAIP aerial imagery for Connecticut from USGS M2M API.
Streams tiles directly to S3 without local buffering.

Usage:
    python pipeline/utils/naip_downloader.py [--max-scenes N]

Env required:
    USGS_M2M_TOKEN  — API token from https://ers.cr.usgs.gov
    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET
"""

import os
import sys
import json
import time
import requests
import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../../backend/.env'))

M2M_BASE = "https://m2m.cr.usgs.gov/api/api/json/stable"
USGS_TOKEN = os.environ.get("USGS_M2M_TOKEN", "")
S3_BUCKET = os.environ.get("S3_BUCKET", "spottr-imagery")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

SESSION = requests.Session()


def m2m_post(endpoint: str, payload: dict) -> dict:
    """POST to USGS M2M API, raise on error."""
    headers = {}
    if USGS_TOKEN:
        headers["X-Auth-Token"] = USGS_TOKEN
    resp = SESSION.post(f"{M2M_BASE}/{endpoint}", json=payload, headers=headers, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    if data.get("errorCode"):
        raise RuntimeError(f"M2M API error [{data['errorCode']}]: {data.get('errorMessage')}")
    return data.get("data", {})


def get_s3_client():
    return boto3.client(
        "s3",
        region_name=AWS_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


def s3_key_exists(s3, key: str) -> bool:
    try:
        s3.head_object(Bucket=S3_BUCKET, Key=key)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "404":
            return False
        raise


def search_naip_scenes(max_results: int = 500) -> list:
    """Search USGS M2M for the most recent NAIP scenes over Connecticut."""
    print("Searching USGS M2M for NAIP scenes in Connecticut...")

    # Connecticut bounding box
    spatial_filter = {
        "filterType": "mbr",
        "lowerLeft":  {"latitude": 40.95, "longitude": -73.73},
        "upperRight": {"latitude": 42.05, "longitude": -71.78},
    }

    # Search scenes — NAIP dataset id: "naip"
    payload = {
        "datasetName": "naip",
        "spatialFilter": spatial_filter,
        "maxResults": max_results,
        "sortField": "acquisitionDate",
        "sortDirection": "DESC",
        "includeUnknownCloudCover": True,
    }

    try:
        result = m2m_post("scene-search", payload)
    except Exception as e:
        print(f"  scene-search failed: {e}")
        print("  Trying dataset alias 'high_res_ortho'...")
        payload["datasetName"] = "high_res_ortho"
        result = m2m_post("scene-search", payload)

    scenes = result.get("results", [])
    print(f"  Found {len(scenes)} scenes (total hits: {result.get('totalHits', '?')})")
    return scenes


def get_download_options(entity_ids: list, dataset_name: str = "naip") -> list:
    """Get download URLs for a batch of scene entity IDs."""
    payload = {
        "datasetName": dataset_name,
        "entityIds": entity_ids,
    }
    result = m2m_post("download-options", payload)
    # Filter to GeoTIFF products
    options = []
    for item in (result if isinstance(result, list) else []):
        if item.get("available") and (
            "GeoTIFF" in item.get("productName", "") or
            "TIFF" in item.get("productName", "") or
            item.get("secondaryDownloads") is None
        ):
            options.append(item)
    return options


def request_downloads(download_options: list) -> list:
    """Request download URLs from M2M download-request endpoint."""
    downloads = [
        {"entityId": opt["entityId"], "productId": opt["id"]}
        for opt in download_options
    ]
    payload = {"downloads": downloads, "systemId": "EE"}
    result = m2m_post("download-request", payload)
    available = result.get("availableDownloads", [])
    preparing = result.get("preparingDownloads", [])
    if preparing:
        print(f"  {len(preparing)} downloads still preparing — will retry...")
    return available


def stream_to_s3(s3, url: str, s3_key: str) -> int:
    """Stream a URL response directly to S3 without local buffering. Returns bytes written."""
    resp = SESSION.get(url, stream=True, timeout=300)
    resp.raise_for_status()

    import io
    from boto3.s3.transfer import TransferConfig

    # Use multipart upload for streaming
    mpu = s3.create_multipart_upload(Bucket=S3_BUCKET, Key=s3_key, ContentType="image/tiff")
    upload_id = mpu["UploadId"]
    parts = []
    part_num = 1
    buffer = io.BytesIO()
    total_bytes = 0
    chunk_size = 8 * 1024 * 1024  # 8 MB parts (S3 minimum is 5 MB)

    try:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            buffer.write(chunk)
            total_bytes += len(chunk)
            if buffer.tell() >= chunk_size:
                buffer.seek(0)
                part = s3.upload_part(
                    Bucket=S3_BUCKET, Key=s3_key,
                    UploadId=upload_id, PartNumber=part_num, Body=buffer,
                )
                parts.append({"PartNumber": part_num, "ETag": part["ETag"]})
                part_num += 1
                buffer = io.BytesIO()

        # Upload remaining buffer
        if buffer.tell() > 0:
            buffer.seek(0)
            part = s3.upload_part(
                Bucket=S3_BUCKET, Key=s3_key,
                UploadId=upload_id, PartNumber=part_num, Body=buffer,
            )
            parts.append({"PartNumber": part_num, "ETag": part["ETag"]})

        s3.complete_multipart_upload(
            Bucket=S3_BUCKET, Key=s3_key, UploadId=upload_id,
            MultipartUpload={"Parts": parts},
        )
        return total_bytes

    except Exception as e:
        s3.abort_multipart_upload(Bucket=S3_BUCKET, Key=s3_key, UploadId=upload_id)
        raise


def quad_id_from_scene(scene: dict) -> str:
    """Extract quad ID from NAIP scene metadata for S3 key naming."""
    # Try displayId, entityId, or fallback to acquisitionDate+coords
    display_id = scene.get("displayId") or scene.get("entityId") or scene.get("orderingId", "unknown")
    # Sanitize to safe S3 key segment
    return display_id.replace("/", "_").replace(" ", "_")


def main(max_scenes: int = 500, dataset_name: str = "naip"):
    if not USGS_TOKEN:
        print("ERROR: USGS_M2M_TOKEN not set in environment")
        sys.exit(1)

    s3 = get_s3_client()

    # Verify S3 bucket accessible
    try:
        s3.head_bucket(Bucket=S3_BUCKET)
        print(f"S3 bucket '{S3_BUCKET}' accessible.")
    except ClientError as e:
        print(f"ERROR: Cannot access S3 bucket '{S3_BUCKET}': {e}")
        sys.exit(1)

    # 1. Search scenes
    scenes = search_naip_scenes(max_results=max_scenes)
    if not scenes:
        print("No scenes found. Check dataset name or spatial filter.")
        sys.exit(1)

    # 2. Get download options in batches of 50
    print(f"\nFetching download options for {len(scenes)} scenes...")
    all_options = []
    entity_ids = [s["entityId"] for s in scenes]
    for i in range(0, len(entity_ids), 50):
        batch = entity_ids[i:i+50]
        try:
            opts = get_download_options(batch, dataset_name)
            all_options.extend(opts)
        except Exception as e:
            print(f"  download-options batch {i//50+1} error: {e}")
        time.sleep(0.5)

    if not all_options:
        print("No download options returned. Scenes may require ordering.")
        print("Tip: Some NAIP scenes need a download-order request first.")
        sys.exit(1)

    print(f"  {len(all_options)} downloadable products found.")

    # 3. Request download URLs
    print("\nRequesting download URLs...")
    available = request_downloads(all_options)
    print(f"  {len(available)} URLs immediately available.")

    if not available:
        print("No URLs available yet. Downloads may be queued for preparation.")
        sys.exit(0)

    # 4. Stream to S3
    print(f"\nStreaming {len(available)} tiles to S3 (prefix: naip/ct/)...")
    downloaded = 0
    errors = 0

    scene_map = {s["entityId"]: s for s in scenes}

    for item in available:
        entity_id = item.get("entityId", "unknown")
        url = item.get("url")
        if not url:
            continue

        scene = scene_map.get(entity_id, {})
        quad_id = quad_id_from_scene(scene) if scene else entity_id
        s3_key = f"naip/ct/{quad_id}.tif"

        # Skip if already uploaded
        if s3_key_exists(s3, s3_key):
            downloaded += 1
            continue

        try:
            bytes_written = stream_to_s3(s3, url, s3_key)
            downloaded += 1
            if downloaded % 10 == 0:
                print(f"  [{downloaded}/{len(available)}] uploaded — last: {s3_key} ({bytes_written/1024/1024:.1f} MB)")
        except Exception as e:
            errors += 1
            print(f"  ERROR {quad_id}: {e}")

        time.sleep(0.2)

    print(f"\nDone. {downloaded} tiles uploaded, {errors} errors.")
    print(f"S3 prefix: s3://{S3_BUCKET}/naip/ct/")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-scenes", type=int, default=500)
    parser.add_argument("--dataset", default="naip")
    args = parser.parse_args()
    main(max_scenes=args.max_scenes, dataset_name=args.dataset)
