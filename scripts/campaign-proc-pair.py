"""Controlled native Intel full-suite comparison, retaining product deadlines."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

base, candidate, output = [Path(value).resolve() for value in sys.argv[1:4]]
output.mkdir(parents=True)
nodes = {"old": Path(os.environ["PAIR_OLD_NODE"]), "new": Path(os.environ["PAIR_NEW_NODE"])}
expected = {"base": "36eb601e55e5f00928412ac5877d5b57f4bd0fca", "candidate": "c782265e6141a1efee6fca2b0c6feb4d7291422c"}
repos = {"base": base, "candidate": candidate}
assert sys.platform == "darwin", "native Darwin required"
rows = []
identities = {"revisions": {}, "runtimes": {}, "bindings": {}}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


for label, repo in repos.items():
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    assert sha == expected[label], "source identity mismatch"
    identities["revisions"][label] = sha
for label, node in nodes.items():
    actual = json.loads(subprocess.check_output([str(node), "-p", "JSON.stringify({version:process.version,arch:process.arch})"], text=True))
    assert actual["arch"] == "x64", "native Intel Node required"
    assert actual["version"] == {"old": "v22.23.1", "new": "v22.23.4"}[label]
    identities["runtimes"][label] = {**actual, "sha256": digest(node)}
identities["harnessSHA256"] = digest(__file__)
(output / "IDENTITIES.json").write_text(json.dumps(identities, indent=2))
common = {key: value for key, value in os.environ.items() if key in {"PATH", "TMPDIR", "RUSTUP_HOME", "CARGO_HOME", "SDKROOT", "DEVELOPER_DIR"}}
common.update(CI="1", MACOSX_DEPLOYMENT_TARGET="10.12", PROC_SAFE_NATIVE="require",
              RUSTUP_HOME=os.environ.get("RUSTUP_HOME", str(Path.home() / ".rustup")))
states = {}
for label in repos:
    state = output / (label + "-state")
    state.mkdir()
    (state / "home").mkdir()
    states[label] = state


def run(label, command, source, runtime, timeout=300):
    state = states[source]
    environment = {**common, "PATH": str(nodes[runtime].parent) + os.pathsep + str(state / "tools/node_modules/.bin") + os.pathsep + common["PATH"],
                   "HOME": str(state / "home"), "CARGO_HOME": str(state / "cargo-home"), "CARGO_TARGET_DIR": str(repos[source] / "target"),
                   "npm_config_cache": str(state / "npm-cache"), "npm_config_manage_package_manager_versions": "false"}
    began = time.monotonic()
    result = subprocess.run([str(value) for value in command], cwd=repos[source], env=environment,
                            capture_output=True, text=True, timeout=timeout)
    for suffix, body in [("stdout", result.stdout), ("stderr", result.stderr)]:
        (output / (label + "." + suffix)).write_text(body)
    row = {"label": label, "source": source, "runtime": runtime, "exit": result.returncode,
           "seconds": time.monotonic() - began,
           "stdoutSHA256": hashlib.sha256(result.stdout.encode()).hexdigest(),
           "stderrSHA256": hashlib.sha256(result.stderr.encode()).hexdigest()}
    rows.append(row)
    (output / "RESULTS.json").write_text(json.dumps(rows, indent=2))
    print(json.dumps(row), flush=True)
    return result.returncode


pnpm = {}
npm = nodes["new"].parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
assert npm.is_file(), "Selected Node installation has no expected npm CLI; setup is not a product verdict"
for label in repos:
    pm_version = json.loads((repos[label] / "package.json").read_text())["packageManager"]
    assert run(label + "-prepare-pnpm", [nodes["new"], npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", states[label] / "tools", pm_version], label, "new") == 0
    pnpm[label] = states[label] / "tools/node_modules/pnpm/bin/pnpm.mjs"
    assert pnpm[label].is_file(), "unexpected pnpm entry point; setup is not a product verdict"
    intended = "old" if label == "base" else "new"
    for name, args in [("install", ["install", "--frozen-lockfile", "--store-dir", str(states[label] / "store")]),
                       ("build", ["build"]), ("native-build", ["native:build"])]:
        assert run(label + "-" + name, [nodes[intended], pnpm[label], *args], label, intended, 600) == 0
    binding = repos[label] / "native/proc-safe-native.darwin-x64.node"
    identities["bindings"][label] = digest(binding)
(output / "IDENTITIES.json").write_text(json.dumps(identities, indent=2))
# One runner, sequential full original suites, separate source homes/stores/native targets.
# Defaults retain original file parallelism, 5000ms outer test deadline and 10000ms child deadline.
for source, runtime in [("base", "old"), ("candidate", "new"), ("base", "new"), ("candidate", "old")]:
    assert run(source + "-" + runtime + "-selected-node", [nodes[runtime], pnpm[source], "exec", "node", "-p", "JSON.stringify({version:process.version,executable:process.execPath,arch:process.arch})"], source, runtime) == 0
    run(source + "-" + runtime + "-full", [nodes[runtime], pnpm[source], "test"], source, runtime)
# Named attribution unknown: determine actual census-child wall cost separately from outer suite.
# This preserves every child assertion and its fixture; it does not turn a replay into a repair.
for source, runtime in [("candidate", "new"), ("base", "old")]:
    run(source + "-" + runtime + "-direct-census", [nodes[runtime], "scripts/darwin-census-proof.mjs"], source, runtime, 30)
raise SystemExit(1 if any(row["exit"] for row in rows) else 0)
