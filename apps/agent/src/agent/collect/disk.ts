import { readFile, statfs } from "node:fs/promises";
import type { DiskStats } from "@cobra/contracts";

/**
 * Pseudo and virtual filesystems carry no useful capacity information and would
 * otherwise flood the list. btrfs subvolumes also mount the same device many
 * times, so we keep the first mount per device.
 */
const IGNORED_FSTYPES = new Set([
  "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "securityfs", "cgroup",
  "cgroup2", "pstore", "efivarfs", "bpf", "autofs", "mqueue", "hugetlbfs",
  "debugfs", "tracefs", "fusectl", "configfs", "ramfs", "binfmt_misc",
  "squashfs", "overlay", "nsfs", "fuse.portal", "iso9660",
]);

/** macOS's disks a person means, written as /proc/mounts lines; the data volume shows as /. */
async function macMountTable(): Promise<string> {
  const { macMounts, output } = await import("./darwin.ts");
  return macMounts(await output("mount", [])).map((m) => `${m.device} ${m.mount.replace(/ /g, "\\040")} ${m.fstype}`).join("\n");
}

export async function collectDisks(): Promise<DiskStats[]> {
  let mounts: string;
  try {
    mounts = process.platform === "darwin" ? await macMountTable() : await readFile("/proc/mounts", "utf8");
  } catch {
    return [];
  }

  const seenDevices = new Set<string>();
  const results: DiskStats[] = [];

  for (const line of mounts.split("\n")) {
    const [device, mount, fstype] = line.split(/\s+/);
    if (!device || !mount || !fstype) continue;
    if (IGNORED_FSTYPES.has(fstype)) continue;
    if (!device.startsWith("/dev/")) continue;
    // btrfs mounts one device at many subvolume paths; one entry is enough.
    if (seenDevices.has(device)) continue;

    try {
      const fs = await statfs(mount.replace(/\\040/g, " "));
      const blockSize = Number(fs.bsize);
      const totalBytes = Number(fs.blocks) * blockSize;
      if (totalBytes === 0) continue;

      // bavail, not bfree: bfree includes root-reserved blocks a normal user
      // can never actually use.
      const freeBytes = Number(fs.bavail) * blockSize;
      const usedBytes = totalBytes - Number(fs.bfree) * blockSize;

      seenDevices.add(device);
      results.push({
        mount: mount === "/System/Volumes/Data" ? "/" : mount,
        device,
        fstype,
        totalBytes,
        freeBytes,
        usedBytes,
        usage: totalBytes > 0 ? usedBytes / totalBytes : 0,
      });
    } catch {
      // A mount we cannot stat (permissions, stale NFS) is skipped rather than
      // failing the whole collection.
    }
  }

  return results.sort((a, b) => a.mount.localeCompare(b.mount));
}
