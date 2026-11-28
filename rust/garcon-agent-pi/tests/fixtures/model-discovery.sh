#!/bin/sh
while [ -f "$0" ]; do sleep 0.1; done &
printf '%s' "$!" > "$0.ready"
printf '%s\n' 'provider  model  context  max-out  thinking  images'
printf '%s\n' 'fixture   text   32K      4K       no        no'
