#!/usr/bin/env bash
# deploy/cloud_run_deploy.sh
# Quest 01: Real deploy script for Cloud Run (documented placeholder).
#
# This script is called by .github/workflows/deploy.yml's deploy step.
# It pulls the freshly built image from GHCR and deploys it to Cloud Run.
#
# Required environment variables:
#   IMAGE_TAG       — git SHA tag of the image to deploy
#   GCP_PROJECT_ID  — Google Cloud project ID
#   GCP_REGION      — Cloud Run region (e.g. us-central1)
#   GHCR_TOKEN      — GitHub token for GHCR auth (from GitHub secrets)
#
# If GCP_PROJECT_ID is not set, the script deploys via docker compose
# (on-prem mode) instead. This keeps the script runnable in any environment.

set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required}"
REGISTRY="ghcr.io"
API_IMAGE="${REGISTRY}/${GITHUB_REPOSITORY:-infamous-rebel/UROS}/uros-api:${IMAGE_TAG}"
UI_IMAGE="${REGISTRY}/${GITHUB_REPOSITORY:-infamous-rebel/UROS}/uros-ui:${IMAGE_TAG}"

echo "=== UROS Deploy ==="
echo "  API Image: ${API_IMAGE}"
echo "  UI Image:  ${UI_IMAGE}"
echo "  Target:    ${ENVIRONMENT:-staging}"

if [ -n "${GCP_PROJECT_ID:-}" ]; then
  echo ""
  echo "--- Cloud Run deployment ---"
  echo "  Project: ${GCP_PROJECT_ID}"
  echo "  Region:  ${GCP_REGION:-us-central1}"

  # Authenticate to GHCR for Cloud Run to pull the image
  echo "${GHCR_TOKEN:-}" | docker login "${REGISTRY}" -u "${GITHUB_ACTOR:-deploy}" --password-stdin 2>/dev/null || true

  # Deploy API service
  gcloud run deploy uros-api \
    --image="${API_IMAGE}" \
    --region="${GCP_REGION:-us-central1}" \
    --project="${GCP_PROJECT_ID}" \
    --platform=managed \
    --no-traffic \
    --tag="${IMAGE_TAG}" \
    --quiet

  # Deploy UI service
  gcloud run deploy uros-ui \
    --image="${UI_IMAGE}" \
    --region="${GCP_REGION:-us-central1}" \
    --project="${GCP_PROJECT_ID}" \
    --platform=managed \
    --no-traffic \
    --tag="${IMAGE_TAG}" \
    --quiet

  # Promote traffic to the new revision
  gcloud run services update-traffic uros-api \
    --to-tags="${IMAGE_TAG}=100" \
    --region="${GCP_REGION:-us-central1}" \
    --project="${GCP_PROJECT_ID}" \
    --quiet

  gcloud run services update-traffic uros-ui \
    --to-tags="${IMAGE_TAG}=100" \
    --region="${GCP_REGION:-us-central1}" \
    --project="${GCP_PROJECT_ID}" \
    --quiet

  echo "  ✓ Cloud Run deployment complete"
else
  echo ""
  echo "--- Docker Compose deployment (on-prem fallback) ---"
  IMAGE_TAG="${IMAGE_TAG}" docker compose -f deploy/docker/docker-compose.yml pull
  IMAGE_TAG="${IMAGE_TAG}" docker compose -f deploy/docker/docker-compose.yml up -d
  echo "  ✓ Docker Compose deployment complete"
fi

echo ""
echo "=== Deploy finished: ${IMAGE_TAG} ==="
