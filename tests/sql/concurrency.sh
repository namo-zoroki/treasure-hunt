#!/usr/bin/env bash
# Phase 4 concurrency checks against a throwaway local Postgres database.
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=th_conc_$$
P="psql -v ON_ERROR_STOP=1 -q -t -A"
$P -d postgres -c "create database $DB"
trap '$P -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
$P -d $DB -c "do \$\$ begin create role anon nologin; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated nologin; exception when duplicate_object then null; end \$\$; do \$\$ begin create role service_role nologin; exception when duplicate_object then null; end \$\$;"
for f in supabase/migrations/001_schema.sql supabase/migrations/002_functions.sql supabase/migrations/003_phase4.sql tests/sql/fixture.sql; do $P -d $DB -f $f >/dev/null; done
Q="$P -d $DB"
fail() { echo "FAIL: $*"; exit 1; }

reg() { for k in $(seq 1 $2); do $Q -c "select register_scan('S$(printf %02d $1)$k','tok$k')" >/dev/null; done; }

# A) same requestId sent 10 times at once -> exactly one attempt, identical answers
reg 1 3; $Q -c "select solve_teaser('S011','the answer')" >/dev/null
RID=11111111-1111-1111-1111-111111111111
for i in $(seq 1 10); do ( $Q -c "select submit_answer('S011','r2',1,'a','$RID')->>'status'" > /tmp/dup_$i.out ) & done; wait
[ "$(cat /tmp/dup_*.out | sort -u | wc -l)" = 1 ] || fail "duplicate requests gave different results"
[ "$($Q -c "select count(*) from attempts where team_id='T01'")" = 1 ] || fail "duplicate requestId inserted more than one row"
rm -f /tmp/dup_*.out; echo "OK A: 10 simultaneous duplicate requestIds -> 1 attempt, same result"

# B) last two answers of a run submitted simultaneously -> run must end up finished (9 teams)
for g in $(seq 2 10); do
  $Q -c "select skip_teaser('T$(printf %02d $g)',1,null)" >/dev/null
  $Q -c "select submit_answer('S$(printf %02d $g)1','r2',1,'c',gen_random_uuid())" >/dev/null
done
for g in $(seq 2 10); do
  s="S$(printf %02d $g)1"
  ( $Q -c "select submit_answer('$s','r2',2,'c',gen_random_uuid())" >/dev/null ) &
  ( $Q -c "select submit_answer('$s','r2',3,'c',gen_random_uuid())" >/dev/null ) &
done; wait
[ "$($Q -c "select count(*) from team_run where run=1 and team_id between 'T02' and 'T10' and finished_ms is not null")" = 9 ] || fail "a run was not marked finished after simultaneous final answers"
[ "$($Q -c "select count(*) from team_run where run=2 and team_id between 'T02' and 'T10'")" = 9 ] || fail "run 2 was not created for each finishing team"
echo "OK B: 9 teams, 2 simultaneous final answers each -> all runs finished, run 2 created"

# C) many teams solve the teaser at the same moment -> every team gets N questions, usage stays balanced
for g in $(seq 11 20); do n=$(( g<=15 ? 4 : 5 )); reg $g $n; done
for g in $(seq 11 20); do ( $Q -c "select solve_teaser('S$(printf %02d $g)1','the answer')" >/dev/null ) & done; wait
[ "$($Q -c "select count(*) from team_questions where team_id between 'T11' and 'T20'")" = $((5*4+5*5)) ] || fail "wrong number of assigned questions"
[ "$($Q -c "select max(c)-min(c) from (select slot,count(*) c from team_questions where team_id between 'T11' and 'T20' group by slot) x")" -le 1 ] || fail "slot usage unbalanced under concurrency"
echo "OK C: 10 simultaneous teaser solves -> all assigned, slots balanced"
echo CONCURRENCY TESTS PASSED
