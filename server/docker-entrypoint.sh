#!/bin/sh
set -eu

for file_var in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*_FILE\)=.*/\1/p'); do
  var_name=${file_var%_FILE}
  file_path=$(eval "printf '%s' \"\${$file_var}\"")
  var_value=$(eval "printf '%s' \"\${$var_name-}\"")

  if [ -n "$var_value" ]; then
    echo "error: both $var_name and $file_var are set; use only one" >&2
    exit 1
  fi

  if [ -z "$file_path" ]; then
    echo "error: $file_var is set but empty" >&2
    exit 1
  fi

  if [ ! -r "$file_path" ]; then
    echo "error: cannot read secret file for $var_name at $file_path" >&2
    exit 1
  fi

  export "$var_name=$(cat "$file_path")"
  unset "$file_var"
done

exec "$@"
