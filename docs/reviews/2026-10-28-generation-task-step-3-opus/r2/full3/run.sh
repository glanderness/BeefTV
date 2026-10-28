#!/bin/bash
cd /tmp/s3r/cand/backend || exit 2
export CGO_ENABLED=1 REVIEW_V26_DB=/tmp/s3r/full3/v26.db REVIEW_V27_DB=/tmp/s3r/full3/v27.db
unset TDS_TEAM_API_KEY WEBCAFE_TOKEN YUN
date -u +%FT%TZ > /tmp/s3r/full3/start.txt
go test ./... -count=1 -timeout=25m > /tmp/s3r/full3/backend-all.txt 2>&1
echo "exit=$?" > /tmp/s3r/full3/exit.txt
date -u +%FT%TZ > /tmp/s3r/full3/end.txt
