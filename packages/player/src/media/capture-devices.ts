import type { CaptureDevice } from "../hosts.js";

type Kind = "Camera" | "Microphone";

/**
 * The name `names` and a device's `name` give for the device at `index`.
 * Flash never names a device "": content checks `names[0]` and sends
 * `names` on, where a server may refuse an empty field. A host may leave a
 * name blank, as browsers do before consent, so such a device is named by
 * its kind and position ("Camera", "Camera 2"), the index getCamera takes.
 */
export function captureDeviceName(device: CaptureDevice, index: number, kind: Kind): string {
  if (device.name.trim()) {
    return device.name;
  }

  return index === 0 ? kind : `${kind} ${index + 1}`;
}

/** Every device's name, as `names` lists them. */
export function captureDeviceNames(devices: readonly CaptureDevice[], kind: Kind): string[] {
  return devices.map((device, index) => captureDeviceName(device, index, kind));
}
