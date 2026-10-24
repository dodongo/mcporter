"""Finite secretless native package/generator proof; executed only on hosted guests."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import shutil
import ssl
import subprocess
import sys
import threading
import time

source = Path(sys.argv[1]).resolve()
work = Path(sys.argv[2]).resolve()
proof = work / "evidence"
proof.mkdir(parents=True)
expected = "4307fdcc994c16f9a021e97cd5d6ea004275e051"
head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
assert head == expected, "candidate identity mismatch"
node = Path(shutil.which("node")).resolve()
bun = Path(shutil.which("bun")).resolve()
npm = (node.parent if sys.platform == "win32" else node.parent.parent / "lib") / "node_modules/npm/bin/npm-cli.js"
assert npm.is_file(), "Selected Node installation has no expected npm CLI; setup is not a product verdict"
env = {key: value for key, value in os.environ.items() if key.upper() in {
    "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
    "PROCESSOR_ARCHITECTURE", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
}}
home = work / "home"
home.mkdir()
env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / "config"),
           CI="1", MCPORTER_NO_FORCE_EXIT="1", BUN_BIN=str(bun),
           npm_config_cache=str(work / "npm-cache"))
rows = []
artifacts = {}
requests = []


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save():
    (proof / "RESULTS.json").write_text(json.dumps({
        "head": head, "platform": sys.platform, "machine": platform.machine(),
        "nodeSHA256": digest(node), "bunSHA256": digest(bun),
        "harnessSHA256": digest(__file__), "artifacts": artifacts,
        "rows": rows, "privateRequests": requests,
    }, indent=2))


def run(label, command, cwd=source, extra=None, timeout=180):
    began = time.monotonic()
    try:
        result = subprocess.run([str(x) for x in command], cwd=cwd,
                                env={**env, **(extra or {})}, capture_output=True,
                                text=True, timeout=timeout)
        code, stdout, stderr = result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired as error:
        rows.append({"label": label, "timeout": True, "seconds": time.monotonic() - began})
        save()
        raise RuntimeError("Bound exceeded: " + label) from error
    (proof / (label + ".stdout")).write_text(stdout)
    (proof / (label + ".stderr")).write_text(stderr)
    rows.append({"label": label, "exit": code, "seconds": time.monotonic() - began,
                 "stdoutSHA256": hashlib.sha256(stdout.encode()).hexdigest(),
                 "stderrSHA256": hashlib.sha256(stderr.encode()).hexdigest()})
    save()
    return code, stdout, stderr


def ok(label, command, **kwargs):
    result = run(label, command, **kwargs)
    assert result[0] == 0, label + " failed; inspect retained diagnostics"
    return result


pnpm = [os.environ["COMSPEC"], "/d", "/s", "/c", "pnpm"] if sys.platform == "win32" else ["pnpm"]
ok("node-version", [node, "--version"])
ok("bun-version", [bun, "--version"])
ok("pack", pnpm + ["pack", "--pack-destination", str(work)], extra={"NPM_CONFIG_IGNORE_SCRIPTS": "true"})
tarball = next(work.glob("mcporter-*.tgz"))
artifacts["npmTarballSHA256"] = digest(tarball)
consumer = work / "consumer"
consumer.mkdir()
(consumer / "package.json").write_text('{"private":true}')
ok("install-package", [node, npm, "install", "--ignore-scripts", "--no-audit", "--no-fund",
                       "--package-lock=false", "--registry=https://registry.npmjs.org/", str(tarball)], cwd=consumer)
cli = consumer / "node_modules/mcporter/dist/cli.js"
version = json.loads((source / "package.json").read_text())["version"]
assert ok("installed-version", [node, cli, "--version"], cwd=consumer)[1].strip() == version
ok("installed-help", [node, cli, "--help"], cwd=consumer)

# The only key is a disposable synthetic issuer and never enters the upload directory.
cert = work / "private-ca.pem"
key = work / "private.key"
config = work / "openssl.cnf"
config.write_text("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=owned-native-proof\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=IP:127.0.0.1\n")
ok("prepare-private-issuer", ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                              "-keyout", key, "-out", cert, "-days", "2", "-config", config])


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        requests.append({"method": data.get("method"), "authorizationPresent": bool(self.headers.get("Authorization"))})
        if "id" not in data:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        method = data.get("method")
        if method == "initialize":
            result = {"protocolVersion": data["params"]["protocolVersion"], "capabilities": {"tools": {}},
                      "serverInfo": {"name": "owned-native-proof", "version": "1.0"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "ping", "description": "Synthetic echo", "inputSchema": {
                "type": "object", "properties": {"echo": {"type": "string"}}}}]}
        elif method == "tools/call":
            echoed = {"ok": True, "echo": data["params"].get("arguments", {}).get("echo")}
            result = {"content": [{"type": "text", "text": json.dumps(echoed)}], "structuredContent": echoed}
        else:
            result = {}
        body = json.dumps({"jsonrpc": "2.0", "id": data["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = "https://127.0.0.1:" + str(server.server_port) + "/mcp"
trusted = {"NODE_EXTRA_CA_CERTS": str(cert)}
try:
    negative = run("installed-private-untrusted", [node, cli, "list", url, "--json", "--exit-code", "--no-oauth", "--timeout", "10000"])
    assert negative[0] != 0 and "cert" in (negative[1] + negative[2]).lower() and not requests
    positive = ok("installed-private-trusted", [node, cli, "list", url, "--json", "--exit-code", "--no-oauth", "--timeout", "10000"], extra=trusted)
    assert "ping" in positive[1] and any(row["method"] == "tools/list" for row in requests)
    for kind in ["node", "bun"]:
        bundle = work / ("generated-node.js" if kind == "node" else "generated-native.exe" if sys.platform == "win32" else "generated-native")
        flag = "--bundle" if kind == "node" else "--compile"
        ok("generate-" + kind, [node, cli, "generate-cli", "--command", url, "--runtime", kind, flag, bundle], cwd=consumer, extra=trusted)
        artifacts["generated-" + kind + "SHA256"] = digest(bundle)
        prefix = [node, bundle] if kind == "node" else [bundle]
        ok("generated-" + kind + "-help", prefix + ["--help"], cwd=consumer, extra=trusted)
        reply = ok("generated-" + kind + "-call", prefix + ["ping", "--echo", "owned-native-marker", "--output", "json"], cwd=consumer, extra=trusted)
        assert json.loads(reply[1].strip())["echo"] == "owned-native-marker"
    if sys.platform == "darwin":
        native = work / "mcporter"
        ok("build-canonical-native", pnpm + ["build:bun", "--target", "bun-darwin-arm64", "--output", native])
        artifacts["canonicalNativeSHA256"] = digest(native)
        assert ok("native-version", [native, "--version"])[1].strip() == version
        ok("native-private-trusted", [native, "list", url, "--json", "--exit-code", "--no-oauth", "--timeout", "10000"], extra=trusted)
        for mode, extra in [("builtin", {}), ("extra-old", {"NODE_EXTRA_CA_CERTS": str(Path(__file__).with_name("campaign-old-ca.pem"))})]:
            for index, host in enumerate(json.loads(Path(__file__).with_name("campaign-incident-hosts.json").read_text())):
                result = run("native-" + mode + "-incident-" + str(index), [native, "list", "https://" + host + "/", "--json", "--exit-code", "--no-oauth", "--timeout", "10000"], extra=extra, timeout=30)
                assert result[0] != 0 and "certificate revoked" in (result[1] + result[2]).lower(), "TLS outcome inconclusive; inspect retained diagnostics"
finally:
    server.shutdown()
    server.server_close()
    save()
print(json.dumps({"pass": True, "head": head, "platform": sys.platform, "scenarios": len(rows)}))
