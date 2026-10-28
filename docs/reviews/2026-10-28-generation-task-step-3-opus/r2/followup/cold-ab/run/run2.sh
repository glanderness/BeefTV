#!/bin/bash
# Cold-open A/B: baseline 6a155448 vs candidate 850d89c1, same plugin dir, alternating isolated runs.
unset TDS_TEAM_API_KEY WEBCAFE_TOKEN YUN
export CGO_ENABLED=1 CANVAS_OFFICIAL_PLUGIN_DIR=/tmp/s3r/basefull/plugin-packages
OUT=/tmp/s3r/coldab/r2
mkdir -p $OUT
date -u +%FT%TZ > $OUT/start.txt
(cd /tmp/s3r/basefull/backend && go test -c -o $OUT/base.test ./internal/bootstrap) || echo "build base failed" >> $OUT/errors.txt
(cd /tmp/s3r/cand/backend && go test -c -o $OUT/cand.test ./internal/bootstrap) || echo "build cand failed" >> $OUT/errors.txt
for i in $(seq 1 15); do
  for label in base cand; do
    dir=/tmp/s3r/basefull/backend/internal/bootstrap; [ $label = cand ] && dir=/tmp/s3r/cand/backend/internal/bootstrap
    (cd $dir && $OUT/$label.test -test.run '^TestDesktopColdOpenBudgetAndNoIdleOutbound$' -test.count=1 -test.v 2>&1 | sed "s/^/[$label #$i] /") >> $OUT/runs.txt
  done
done
date -u +%FT%TZ > $OUT/end.txt
