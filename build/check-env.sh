#!/usr/bin/env bash
echo "whoami=$(whoami)"
echo "sudo_passwordless=$(sudo -n true 2>/dev/null && echo yes || echo no)"
echo "--- tools ---"
for t in git make python3 pip3 pkg-config gcc g++ cc cmake curl wget xz tar node npm; do
    if command -v "$t" >/dev/null 2>&1; then
        printf "OK   %-11s %s\n" "$t" "$(command -v "$t")"
    else
        printf "MISS %-11s\n" "$t"
    fi
done
echo "--- versions ---"
command -v make    >/dev/null 2>&1 && make --version | head -1
command -v python3 >/dev/null 2>&1 && python3 --version
command -v gcc     >/dev/null 2>&1 && gcc -dumpversion 2>/dev/null
command -v node    >/dev/null 2>&1 && node --version
command -v npm     >/dev/null 2>&1 && npm --version
command -v pkg-config >/dev/null 2>&1 && pkg-config --version
echo "--- apt available? ---"
command -v apt-get >/dev/null 2>&1 && echo "apt-get present" || echo "no apt"
