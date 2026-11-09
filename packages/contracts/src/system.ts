import { z } from "zod";

/** A fraction in [0,1]. Kept as a fraction, not a percentage, so the UI decides formatting. */
const Fraction = z.number().min(0).max(1);

export const CpuStats = z.object({
  model: z.string(),
  /** Logical CPUs, i.e. `nproc`. Both Macs report 4 from 2 physical cores. */
  threads: z.number().int().positive(),
  /** Busy fraction across all threads since the previous sample. */
  usage: Fraction,
  loadavg: z.tuple([z.number(), z.number(), z.number()]),
});

export const MemoryStats = z.object({
  totalBytes: z.number().int(),
  /** MemAvailable, not MemFree — free memory is meaningless with page cache. */
  availableBytes: z.number().int(),
  usedBytes: z.number().int(),
  usage: Fraction,
  swapTotalBytes: z.number().int(),
  swapUsedBytes: z.number().int(),
  /** True when zram is carrying swap. All three machines should report true. */
  zram: z.boolean(),
});

export const DiskStats = z.object({
  mount: z.string(),
  device: z.string(),
  fstype: z.string(),
  totalBytes: z.number().int(),
  freeBytes: z.number().int(),
  usedBytes: z.number().int(),
  usage: Fraction,
});

export const NetStats = z.object({
  iface: z.string(),
  rxBytes: z.number().int(),
  txBytes: z.number().int(),
  /** Bytes/sec since the previous sample. Null on the first sample. */
  rxRate: z.number().nullable(),
  txRate: z.number().nullable(),
});

export const ThermalStats = z.object({
  label: z.string(),
  celsius: z.number(),
});

/**
 * Battery, charger, lid and lid-awake (desktop/lid-awake). Nulls on a machine
 * without that hardware; `lidAwake.available` is false where it is not
 * installed. Optional on SystemStats so an older agent still validates.
 */
export const PowerStats = z.object({
  ac: z.boolean().nullable(),
  battery: z.number().nullable(),
  /** "open" | "closed" — a string, not an enum (gotcha 18). */
  lid: z.string().nullable(),
  lidAwake: z.object({ available: z.boolean(), on: z.boolean() }),
});

export const SystemStats = z.object({
  host: z.string(),
  kernel: z.string(),
  uptimeSeconds: z.number(),
  capturedAt: z.string().datetime(),
  cpu: CpuStats,
  memory: MemoryStats,
  disks: z.array(DiskStats),
  network: z.array(NetStats),
  thermal: z.array(ThermalStats),
  power: PowerStats.optional(),
});

export type CpuStats = z.infer<typeof CpuStats>;
export type MemoryStats = z.infer<typeof MemoryStats>;
export type DiskStats = z.infer<typeof DiskStats>;
export type NetStats = z.infer<typeof NetStats>;
export type ThermalStats = z.infer<typeof ThermalStats>;
export type PowerStats = z.infer<typeof PowerStats>;
export type SystemStats = z.infer<typeof SystemStats>;
