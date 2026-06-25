import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import QRCode from "qrcode";

const execFileAsync = promisify(execFile);

export async function showConnectQrInPreview(connectUrl) {
  const pngPath = join(tmpdir(), `remote-cursor-connect-${Date.now()}.png`);

  try {
    const pngBuffer = await QRCode.toBuffer(connectUrl, {
      type: "png",
      width: 640,
      margin: 2,
      errorCorrectionLevel: "M",
    });

    await writeFile(pngPath, pngBuffer);
    await execFileAsync("open", ["-a", "Preview", pngPath]);

    // Preview copies the file on open; remove our temp copy shortly after.
    setTimeout(() => {
      unlink(pngPath).catch(() => {});
    }, 5000);

    return pngPath;
  } catch (error) {
    await unlink(pngPath).catch(() => {});
    throw error;
  }
}
