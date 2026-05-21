# Spottr — Infrastructure Teardown Checklist

Use this checklist when canceling paid services. Do not delete the git repo —
keep it as a portfolio artifact. Archive, don't destroy.

---

## ⚠️ MUST ROTATE IMMEDIATELY — Keys in Git History

The following secrets appear in committed files (`SPOTTR_BUILD_SPEC.md`,
`SPOTTR_SPEC_ADDENDUM_V4.md`) and are therefore permanently in git history.
**Rotate these regardless of teardown status:**

- `REDACTED_GOOGLE_KEY_1` — Google Maps/Places API key
  (appears at SPOTTR_BUILD_SPEC.md:774 and SPOTTR_SPEC_ADDENDUM_V4.md:18)
- `REDACTED_AWS_KEY_ID_2` — AWS Access Key ID
  (appears at SPOTTR_BUILD_SPEC.md:820)

**How to rotate:**
1. Google: GCP Console → APIs & Services → Credentials → delete/regenerate key
2. AWS: IAM Console → Users → Security credentials → deactivate + delete key

The spec files themselves are historical documentation and do not need to be
removed from the repo — the keys only need to be rotated in the actual services.

---

## Service Teardown Order

Cancellation order matters: **cancel Modal last** so the detection pipeline can
be rerun against the frozen demo assets if needed.

### 1. Google Places / Maps API
- [ ] Go to GCP Console → APIs & Services → Credentials
- [ ] Delete or disable key `AIzaSyAY3aW3vd3g...` (rotate first — see above)
- [ ] Set per-API quotas to 0 for: Places API (New), Maps Static API
- [ ] Estimated monthly cost saved: ~$0–5 (likely within free tier for low usage)

### 2. Mapbox
- [ ] Go to Mapbox → Account → Access Tokens
- [ ] Revoke the Spottr production token
- [ ] Free tier — no billing cancellation needed, but rotate for safety
- [ ] Estimated monthly cost saved: $0 (free tier) or ~$5–50 if exceeded

### 3. BestTime.app
- [ ] Rotate API keys in BestTime dashboard (keys may have appeared in development conversations)
- [ ] Cancel subscription if any paid tier was activated
- [ ] Free tier trial expires automatically — verify no credit card on file
- [ ] Estimated monthly cost saved: $0–29

### 4. Outscraper
- [ ] Never funded — no action needed
- [ ] Confirm no credit card was added to account

### 5. INRIX Developer
- [ ] Trial access expires automatically in 30 days from signup
- [ ] No credit card required for trial — confirm no billing activated
- [ ] Estimated monthly cost saved: $0

### 6. Railway
- [ ] Go to Railway → Project → Settings → Danger Zone → Delete Project
- [ ] This removes: Node.js backend service, PostgreSQL add-on, Redis add-on
- [ ] Before deleting: export final DB dump if you want the lot data preserved:
  ```bash
  railway run pg_dump $DATABASE_URL > spottr_final_dump.sql
  ```
- [ ] Estimated monthly cost saved: ~$20–35 (Hobby plan + DB storage)

### 7. Modal
- [ ] Cancel last so detection can be rerun if needed
- [ ] Go to Modal → Settings → Billing → Cancel plan
- [ ] Delete any persistent volumes if created (check Modal dashboard → Volumes)
- [ ] Estimated monthly cost saved: ~$0–15 (pay-per-use, minimal if idle)

### 8. AWS / S3
- [ ] Check S3 for any `spottr-imagery` bucket created for CV tile caching
  (this feature was designed but not confirmed as deployed — verify in S3 console)
- [ ] If bucket exists: download contents, then delete bucket
- [ ] Rotate AWS key `REDACTED_AWS_KEY_ID_2` regardless (see above)
- [ ] Estimated monthly cost saved: ~$0–5

### 9. Domain
- [ ] Check if `spottr.app` or similar is registered with your registrar
- [ ] Decide: let expire vs transfer to personal portfolio domain
- [ ] Estimated annual cost saved: ~$15–30/year

---

## Estimated Total Monthly Savings

| Service | Est. Monthly Cost |
|---------|-------------------|
| Railway (backend + DB) | $20–35 |
| Modal (GPU, pay-per-use) | $0–15 |
| Google Places API | $0–5 |
| Mapbox | $0–50 |
| BestTime | $0–29 |
| **Total** | **~$20–134/month** |

Likely actual spend at archive time (low-traffic development): **~$25–40/month**
(Railway is the dominant cost; all other services at or near free tiers).

---

## Post-Teardown Portfolio State

After teardown, the repo remains fully self-contained for portfolio review:

- `demo/cv-pipeline/` — real detection pipeline images (no live service needed)
- `demo/api-responses/` — frozen JSON showing real data shapes
- `demo/architecture/` — Mermaid diagrams of system architecture
- `README.md` — updated with archived status and "Why It Doesn't Ship"
- All source code intact — backend, mobile, Modal function, migrations
