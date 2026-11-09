import { test } from "node:test";
import assert from "node:assert/strict";

import { launchdState, macMounts, netstatBytes, pmsetBattery, swapUsage, vmAvailable } from "./darwin.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                           50000.
Pages speculative:                         2000.
Pages throttled:                              0.
Pages wired down:                         90000.
Pages purgeable:                           1000.
`;

test("vm_stat: free, inactive, speculative and purgeable pages are available", () => {
  assert.equal(vmAvailable(VM_STAT), (10000 + 50000 + 2000 + 1000) * 16384);
  assert.equal(vmAvailable("nothing here"), null);
});

test("sysctl vm.swapusage in bytes", () => {
  assert.deepEqual(swapUsage("total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)"), { total: 2048 * 1024 ** 2, used: Math.round(1024.5 * 1024 ** 2) });
  assert.deepEqual(swapUsage("total = 0.00M  used = 0.00M  free = 0.00M"), { total: 0, used: 0 });
  assert.deepEqual(swapUsage(""), { total: 0, used: 0 });
});

const MOUNT = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)
/dev/disk3s2 on /System/Volumes/Preboot (apfs, local, journaled, nobrowse)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)
map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
/dev/disk5s1 on /Volumes/Backup Drive (apfs, local, nodev, nosuid, journaled, noowners)
`;

test("mount: the data volume and drives under /Volumes; not the sealed system or helper volumes", () => {
  assert.deepEqual(macMounts(MOUNT), [
    { device: "/dev/disk3s5", mount: "/System/Volumes/Data", fstype: "apfs" },
    { device: "/dev/disk5s1", mount: "/Volumes/Backup Drive", fstype: "apfs" },
  ]);
  assert.deepEqual(macMounts("/dev/disk1s1 on / (hfs, local, journaled)\n"), [{ device: "/dev/disk1s1", mount: "/", fstype: "hfs" }], "no data volume: / itself");
});

const NETSTAT = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                         1000     0     500000     1000     0     500000     0
lo0        16384 127           127.0.0.1          1000     -     500000     1000     -     500000     -
en0        1500  <Link#11>   aa:bb:cc:dd:ee:ff  200000     0  300000000   100000     0   20000000     0
en0        1500  192.168.1     192.168.1.20    200000     -  300000000   100000     -   20000000     -
utun0      1380  <Link#20>                          10     0       1200       12     0       1400     0
`;

test("netstat -ibn: each interface's bytes once, from its Link line, with or without an address", () => {
  assert.deepEqual(netstatBytes(NETSTAT), [
    { iface: "lo0", rxBytes: 500000, txBytes: 500000 },
    { iface: "en0", rxBytes: 300000000, txBytes: 20000000 },
    { iface: "utun0", rxBytes: 1200, txBytes: 1400 },
  ]);
  assert.deepEqual(netstatBytes(""), []);
});

test("pmset -g batt: AC and the battery; a desktop Mac has no battery", () => {
  assert.deepEqual(pmsetBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t87%; discharging; 4:12 remaining present: true\n"), { ac: false, battery: 87 });
  assert.deepEqual(pmsetBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true\n"), { ac: true, battery: 100 });
  assert.deepEqual(pmsetBattery("Now drawing from 'AC Power'\n"), { ac: true, battery: null });
});

test("launchctl print: running, loaded and stopped, or not there", () => {
  assert.deepEqual(launchdState("gui/501/app.cobra.agent = {\n\tactive count = 1\n\tstate = running\n}"), { enabled: true, active: true });
  assert.deepEqual(launchdState("gui/501/app.cobra.agent = {\n\tstate = not running\n}"), { enabled: true, active: false });
  assert.deepEqual(launchdState('Bad request.\nCould not find service "app.cobra.agent" in domain for user gui: 501'), { enabled: false, active: false });
  assert.deepEqual(launchdState(""), { enabled: false, active: false });
});
