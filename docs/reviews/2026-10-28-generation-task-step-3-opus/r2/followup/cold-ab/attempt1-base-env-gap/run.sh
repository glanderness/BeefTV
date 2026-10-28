#!/bin/bash
# Alternate base/cand, 10 isolated runs each of the cold-open budget test; record per-run duration.
unset TDS_TEAM_API_KEY WEBCAFE_TOKEN YUN
export CGO_ENABLED=1
date -u +%FT%TZ > /tmp/s3r/coldab/start.txt
for label in base cand; do (cd /tmp/s3r/$label/backend && go test -c -o /tmp/s3r/coldab/$label.test ./internal/bootstrap) || echo "build $label failed" >> /tmp/s3r/coldab/errors.txt; done
for i in $(seq 1 10); do
  for label in base cand; do
    (cd /tmp/s3r/$label/backend/internal/bootstrap && /tmp/s3r/coldab/$label.test -test.run '^TestDesktopColdOpenBudgetAndNoIdleOutbound$' -test.count=1 -test.v 2>&1 | sed "s/^/[$label #$i] /") >> /tmp/s3r/coldab/runs.txt
  done
done
echo done > /tmp/s3r/coldab/exit.txt
date -u +%FT%TZ > /tmp/s3r/coldab/end.txt
