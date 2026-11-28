#!/bin/sh
if [ "$1:$2:$3:$4:$5:$7:$8" != "--mode:text:--no-session:--no-tools:--model:--thinking:high" ]; then
    printf 'unexpected arguments\n' >&2
    exit 9
fi
if [ "$6" = "synthetic/failure" ]; then
    printf 'synthetic exit diagnostic\n' >&2
    exit 7
fi
printf 'echo:'
cat
