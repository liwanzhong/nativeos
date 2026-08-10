"""List OSS app/asr-tmp/ and app/ to verify cleanup worked."""
import sys
sys.path.insert(0, r'E:\mycodes\deckmind\NativeOS\videoinfo-gengui')
import oss2
from tabs.runtime_support import load_json_config

cfg = load_json_config().get('oss', {})
auth = oss2.Auth(cfg['access_key_id'], cfg['access_key_secret'])
bucket = oss2.Bucket(auth, cfg['endpoint'], cfg['bucket'])

print("Listing app/asr-tmp/:")
count = 0
for obj in oss2.ObjectIterator(bucket, prefix='app/asr-tmp/', max_keys=50):
    print(f"  {obj.key}  size={obj.size}  last_modified={obj.last_modified}")
    count += 1
if count == 0:
    print("  (empty)")

print()
print("Listing app/ (top 5):")
for obj in oss2.ObjectIterator(bucket, prefix='app/', max_keys=5):
    print(f"  {obj.key}  size={obj.size}  last_modified={obj.last_modified}")
