#!/usr/bin/env bash
exec "$(dirname "$0")/../.github/actions/run-agent-evals/run.sh" "$@"
