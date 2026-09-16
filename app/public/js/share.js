// A share card, drawn on the device.
//
// Sharing is the only way this app spreads, since there is no account to invite
// anyone to. The card is rendered here from the numbers already on screen - no
// photo, no upload, nothing recognisable about the person.

/** The words on the card and in the share sheet. Pure, so it is unit-testable. */
export function shareCaption({ bodyFatPct, leanerThan, group }) {
  const rank = leanerThan != null ? ` Leaner than ${Math.round(leanerThan)}% of ${group}.` : "";
  return `${bodyFatPct.toFixed(1)}% body fat, measured from two photos on my phone.${rank}`;
}

const VOLT = "#CCFF3F", INK = "#0B0E02", BG = "#0A0C10", CARD = "#141821";
const TEXT = "#F3F5F8", MUTED = "#8A91A0";

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw a 1080x1350 card (the 4:5 shape most feeds prefer).
 * Kept separate from the DOM so it can be pointed at any canvas context.
 */
export function drawShareCard(ctx, data) {
  const W = 1080, H = 1350;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W / 2, 220, 40, W / 2, 220, 720);
  glow.addColorStop(0, "rgba(204,255,63,0.16)");
  glow.addColorStop(1, "rgba(204,255,63,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 900);

  // wordmark
  ctx.fillStyle = VOLT;
  roundRect(ctx, 80, 84, 54, 54, 16);
  ctx.fill();
  ctx.fillStyle = TEXT;
  ctx.font = "800 44px 'Bricolage Grotesque', system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("bodycomp", 152, 112);

  // headline number
  ctx.textAlign = "center";
  ctx.fillStyle = MUTED;
  ctx.font = "700 30px 'Figtree', system-ui, sans-serif";
  ctx.fillText("BODY FAT", W / 2, 330);
  ctx.fillStyle = VOLT;
  ctx.font = "800 260px 'Bricolage Grotesque', system-ui, sans-serif";
  ctx.fillText(`${data.bodyFatPct.toFixed(1)}%`, W / 2, 480);

  if (data.band) {
    ctx.fillStyle = TEXT;
    ctx.font = "800 42px 'Figtree', system-ui, sans-serif";
    ctx.fillText(data.band, W / 2, 640);
  }
  if (data.leanerThan != null) {
    ctx.fillStyle = MUTED;
    ctx.font = "600 34px 'Figtree', system-ui, sans-serif";
    ctx.fillText(`Leaner than ${Math.round(data.leanerThan)}% of ${data.group}`, W / 2, 700);
  }

  // stat tiles
  const tiles = [
    ["Lean mass", `${data.fatFreeMassKg.toFixed(1)} kg`],
    ["Weight", `${data.weightKg.toFixed(1)} kg`],
    [data.changeLabel || "Scans", data.changeValue || String(data.scans || 1)],
  ];
  const tw = 290, gap = 30, x0 = (W - (tiles.length * tw + (tiles.length - 1) * gap)) / 2;
  tiles.forEach(([k, v], i) => {
    const x = x0 + i * (tw + gap);
    ctx.fillStyle = CARD;
    roundRect(ctx, x, 800, tw, 190, 28);
    ctx.fill();
    ctx.fillStyle = MUTED;
    ctx.font = "700 26px 'Figtree', system-ui, sans-serif";
    ctx.fillText(k, x + tw / 2, 858);
    ctx.fillStyle = TEXT;
    ctx.font = "800 58px 'Bricolage Grotesque', system-ui, sans-serif";
    ctx.fillText(v, x + tw / 2, 930);
  });

  // footer: the claim, and its limits
  ctx.fillStyle = MUTED;
  ctx.font = "600 30px 'Figtree', system-ui, sans-serif";
  ctx.fillText("Measured from two photos, entirely on my phone", W / 2, 1120);
  ctx.font = "500 25px 'Figtree', system-ui, sans-serif";
  ctx.fillText("Model validated against 11,701 clinical DXA scans  ·  ±2.8% average error", W / 2, 1168);
  ctx.fillStyle = "#5C6472";
  ctx.font = "500 23px 'Figtree', system-ui, sans-serif";
  ctx.fillText("A fitness estimate, not a medical device", W / 2, 1240);
  return ctx.canvas;
}

/** Render, then hand off to the OS share sheet, falling back to a download. */
export async function shareResult(data) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1350;
  drawShareCard(canvas.getContext("2d"), data);

  const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
  const file = new File([blob], "bodycomp.png", { type: "image/png" });
  const text = shareCaption(data);

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text });
      return "shared";
    } catch (err) {
      if (err.name === "AbortError") return "cancelled";   // user closed the sheet
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "bodycomp.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "downloaded";
}
