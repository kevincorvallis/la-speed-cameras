#!/bin/sh
# Run every test suite at the same time. Exit 1 when any suite fails.
#   sh scripts/ci.sh
cd "$(dirname "$0")/.." || exit 1
out=$(mktemp -d)

run() {
  name=$1
  shift
  ( "$@" >"$out/$name.log" 2>&1; echo $? >"$out/$name.code" ) &
}

run lint npm run -s test:lint
run unit npm run -s test:unit
run build npm run -s test:py
run browser npm run -s test:e2e
wait

fail=0
for name in lint unit build browser; do
  code=$(cat "$out/$name.code")
  if [ "$code" = 0 ]; then
    echo "PASS  $name  $(tail -n 3 "$out/$name.log" | tr '\n' ' ')"
  else
    echo "FAIL  $name  (exit $code)"
    fail=1
  fi
done
for name in lint unit build browser; do
  if [ "$(cat "$out/$name.code")" != 0 ]; then
    echo
    echo "----- $name -----"
    tail -n 60 "$out/$name.log"
  fi
done
exit $fail
