import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import QRCode from "qrcode";

const execFileAsync = promisify(execFile);

async function openInPreviewCentered(pngPath) {
  const escapedPath = pngPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
tell application "Finder"
  set desktopBounds to bounds of window of desktop
  set screenLeft to item 1 of desktopBounds
  set screenTop to item 2 of desktopBounds
  set screenRight to item 3 of desktopBounds
  set screenBottom to item 4 of desktopBounds
  set screenWidth to screenRight - screenLeft
  set screenHeight to screenBottom - screenTop
end tell

tell application "Preview"
  open POSIX file "${escapedPath}"
  activate
  repeat with i from 1 to 20
    if (count of windows) > 0 then exit repeat
    delay 0.1
  end repeat
  if (count of windows) > 0 then
    tell front window
      set winBounds to bounds
      set winWidth to (item 3 of winBounds) - (item 1 of winBounds)
      set winHeight to (item 4 of winBounds) - (item 2 of winBounds)
      set newLeft to screenLeft + (screenWidth - winWidth) / 2
      set newTop to screenTop + (screenHeight - winHeight) / 2
      set bounds to {newLeft, newTop, newLeft + winWidth, newTop + winHeight}
    end tell
  end if
end tell
`;

  await execFileAsync("osascript", ["-e", script]);
}

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
    await openInPreviewCentered(pngPath);

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
