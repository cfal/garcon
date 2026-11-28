#!/bin/sh
cd "$(dirname "$0")" || exit 1
wait_for_release() {
  for _ in $(seq 1 500); do
    if test -f release; then return 0; fi
    sleep 0.01
  done
  exit 1
}
case "$1" in
  models)
    if test -f signed-in; then printf 'new-model\tNew Model\n'; else
      touch models-started
      wait_for_release
    fi ;;
  acp)
    if test "$2" = --login; then
      printf 'https://example.test/login\n'
      read -r code && test "$code" = synthetic-code && touch signed-in
    else
      read -r init && echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
      read -r auth
      if test -f signed-in; then
        echo '{"jsonrpc":"2.0","id":2,"result":{}}'
        read -r initialized
      else
        touch auth-started
        wait_for_release
        echo '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Signed out"}}'
      fi
    fi ;;
esac
