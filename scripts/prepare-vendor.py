"""Fetch only the exact official sandbox source and license; execute no package scripts."""
import base64, hashlib, io, json, pathlib, tarfile, urllib.request
root = pathlib.Path(__file__).resolve().parents[1]
url = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh-sandbox-local/0.2.2-rc.3'
with urllib.request.urlopen(url, timeout=30) as response:
    metadata = json.load(response)
with urllib.request.urlopen(metadata['dist']['tarball'], timeout=30) as response:
    archive = response.read()
integrity = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode()
if integrity != metadata['dist']['integrity']:
    raise RuntimeError('Official package integrity mismatch')
out = root / 'lib' / 'vendor'
out.mkdir(parents=True, exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
    source = package.extractfile('package/lib/index.js').read()
    license_text = package.extractfile('package/LICENSE').read()
    (out / 'sandbox-local.official.js.txt').write_bytes(source)
    (out / 'DeepSeek-LICENSE.txt').write_bytes(license_text)
evidence = {'package':metadata['name'],'version':metadata['version'],'tarball':metadata['dist']['tarball'],'integrity':integrity,'sourceSha256':hashlib.sha256(source).hexdigest()}
(out / 'provenance.json').write_text(json.dumps(evidence, indent=2)+'\n', encoding='utf-8')
print(json.dumps(evidence))
