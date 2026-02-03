# Manual Setup Commands

Commands that were run manually during testing that should be incorporated into the init flow.

## LVM Fixes

```bash
# Remove broken LVM volume (was created with wrong size)
lvremove -f sandbox-vg/image-dev-base

# Remove broken ext4 image
rm -f /var/lib/sandbox/firecracker/rootfs/dev-base.ext4
```

## Image Building

After deploy, must build the base image:
```bash
frak-sandbox images build dev-base
```

## TODO: Add to init flow

1. After `frak-sandbox storage` setup, automatically build dev-base image
2. Ensure LVM thin pool has enough space for base images
3. Add health check to verify image was built correctly

---

## Testing Commands

### Check LVM status
```bash
vgdisplay sandbox-vg
lvs sandbox-vg
```

### Check manager health
```bash
curl http://localhost:4000/health
```

### List images via API
```bash
curl http://localhost:4000/api/images
```
