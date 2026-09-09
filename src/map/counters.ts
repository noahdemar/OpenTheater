import type { UnitKind } from '../game/types';

/**
 * NATO-style unit counters, drawn once per (kind, colour, echelon) and handed
 * to MapLibre as images. Cheaper than a sprite sheet and it keeps every
 * nation's colour exact.
 */
const W = 34, H = 22, R = 2;

export type Echelon = 'company' | 'battalion' | 'regiment' | 'brigade' | 'division' | 'corps' | 'army' | 'group';

const ECHELON_MARK: Record<Echelon, string> = {
  company: 'I', battalion: 'II', regiment: 'III', brigade: 'X',
  division: 'XX', corps: 'XXX', army: 'XXXX', group: 'XXXXX',
};

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + amount * 255)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function drawSymbol(ctx: CanvasRenderingContext2D, kind: UnitKind, w: number, h: number) {
  ctx.strokeStyle = 'rgba(20,16,12,0.9)';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  const pad = 4;
  const cross = () => {
    ctx.moveTo(pad, pad); ctx.lineTo(w - pad, h - pad);
    ctx.moveTo(w - pad, pad); ctx.lineTo(pad, h - pad);
  };
  ctx.beginPath();
  switch (kind) {
    case 'light':                       // infantry: crossed straps
      cross();
      break;
    case 'territorial':                 // infantry over a ground bar
      cross();
      ctx.moveTo(pad, h - pad + 1); ctx.lineTo(w - pad, h - pad + 1);
      break;
    case 'mechanised':                  // infantry inside the armour oval
      ctx.ellipse(w / 2, h / 2, w / 2 - pad - 1, h / 2 - pad, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pad + 3, pad + 2); ctx.lineTo(w - pad - 3, h - pad - 2);
      ctx.moveTo(w - pad - 3, pad + 2); ctx.lineTo(pad + 3, h - pad - 2);
      break;
    case 'armoured':                    // the armour oval alone
      ctx.ellipse(w / 2, h / 2, w / 2 - pad - 1, h / 2 - pad, 0, 0, Math.PI * 2);
      break;
    case 'airborne':                    // infantry under a wing
      cross();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(w / 2 - 8, pad + 3);
      ctx.quadraticCurveTo(w / 2, pad - 2, w / 2 + 8, pad + 3);
      break;
    case 'airwing': {                   // a wing, for air
      ctx.moveTo(pad + 1, h / 2);
      ctx.quadraticCurveTo(w / 2, pad - 1, w - pad - 1, h / 2);
      ctx.moveTo(pad + 1, h / 2);
      ctx.quadraticCurveTo(w / 2, h - pad + 1, w - pad - 1, h / 2);
      break;
    }
    case 'orbital': {                   // an orbit around a body
      ctx.ellipse(w / 2, h / 2, w / 2 - pad - 2, h / 2 - pad - 1, -0.35, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 2.2, 0, Math.PI * 2);
      break;
    }
    case 'flotilla': {                  // a hull on the water
      ctx.moveTo(pad, h / 2 - 1);
      ctx.lineTo(w - pad, h / 2 - 1);
      ctx.lineTo(w - pad - 4, h - pad - 1);
      ctx.lineTo(pad + 4, h - pad - 1);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(w / 2, h / 2 - 1); ctx.lineTo(w / 2, pad + 1);
      break;
    }
    case 'marine':                      // infantry over a wave
      cross();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(w / 2 - 7, h - pad - 1);
      ctx.quadraticCurveTo(w / 2 - 3.5, h - pad - 5, w / 2, h - pad - 1);
      ctx.quadraticCurveTo(w / 2 + 3.5, h - pad + 3, w / 2 + 7, h - pad - 1);
      break;
  }
  ctx.stroke();
}

export const COUNTER_W = W;
export const COUNTER_H = H + 8;

export type IconStyle = 'nato' | 'pictorial';

const cache = new Map<string, HTMLCanvasElement>();

/**
 * Pictorial silhouettes: what the formation actually is, rather than what NATO
 * calls it. Easier to read at a glance for anyone who has not memorised the
 * symbol set.
 */
function drawPicture(ctx: CanvasRenderingContext2D, kind: UnitKind, w: number, h: number) {
  const cx = w / 2, cy = h / 2;
  ctx.fillStyle = 'rgba(20,16,12,0.92)';
  ctx.strokeStyle = 'rgba(20,16,12,0.92)';
  ctx.lineWidth = 1.3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (kind) {
    case 'light':
    case 'territorial': {                       // an army helmet
      ctx.beginPath();                                    // dome
      ctx.ellipse(cx, cy + 1, 7, 6, 0, Math.PI, 0);
      ctx.fill();
      ctx.beginPath();                                    // brim
      ctx.moveTo(cx - 9.5, cy + 1);
      ctx.quadraticCurveTo(cx, cy + 4.6, cx + 9.5, cy + 1);
      ctx.quadraticCurveTo(cx, cy + 2.2, cx - 9.5, cy + 1);
      ctx.closePath();
      ctx.fill();
      if (kind === 'territorial') {                       // a bar marks militia
        ctx.beginPath();
        ctx.moveTo(cx - 5, cy + 6.5);
        ctx.lineTo(cx + 5, cy + 6.5);
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
      break;
    }
    case 'mechanised': {                        // wheeled carrier
      ctx.beginPath();
      ctx.moveTo(cx - 8, cy + 1.5);
      ctx.lineTo(cx - 6.5, cy - 3);
      ctx.lineTo(cx + 4, cy - 3);
      ctx.lineTo(cx + 8, cy + 1.5);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();                                    // gun
      ctx.moveTo(cx, cy - 3);
      ctx.lineTo(cx + 7, cy - 5.5);
      ctx.lineWidth = 1.3;
      ctx.stroke();
      for (const x of [-5, 0, 5]) {                       // wheels
        ctx.beginPath();
        ctx.arc(cx + x, cy + 3.4, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'armoured': {                          // tank, side on
      ctx.beginPath();                                    // hull
      ctx.moveTo(cx - 8.5, cy + 0.5);
      ctx.lineTo(cx + 8.5, cy + 0.5);
      ctx.lineTo(cx + 7, cy + 3);
      ctx.lineTo(cx - 7, cy + 3);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();                                    // turret
      ctx.moveTo(cx - 4, cy + 0.5);
      ctx.lineTo(cx - 2.5, cy - 3.2);
      ctx.lineTo(cx + 2.5, cy - 3.2);
      ctx.lineTo(cx + 4, cy + 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();                                    // barrel
      ctx.moveTo(cx + 2, cy - 2);
      ctx.lineTo(cx + 10, cy - 2);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      for (const x of [-6.5, -2, 2, 6.5]) {               // road wheels
        ctx.beginPath();
        ctx.arc(cx + x, cy + 4.6, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'airborne': {                          // helicopter
      ctx.beginPath();                                    // rotor
      ctx.moveTo(cx - 9, cy - 5);
      ctx.lineTo(cx + 9, cy - 5);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - 5);
      ctx.lineTo(cx, cy - 3);
      ctx.stroke();
      ctx.beginPath();                                    // body
      ctx.ellipse(cx - 1, cy + 0.5, 5, 3.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();                                    // tail
      ctx.moveTo(cx + 3.5, cy - 0.5);
      ctx.lineTo(cx + 10, cy - 1.6);
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.beginPath();                                    // tail rotor
      ctx.moveTo(cx + 9.5, cy - 4);
      ctx.lineTo(cx + 10.5, cy + 1);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();                                    // skids
      ctx.moveTo(cx - 6, cy + 5);
      ctx.lineTo(cx + 3, cy + 5);
      ctx.stroke();
      break;
    }
    case 'marine': {                            // landing craft
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy + 0.5);
      ctx.lineTo(cx + 8, cy + 0.5);
      ctx.lineTo(cx + 5.5, cy + 4.5);
      ctx.lineTo(cx - 7, cy + 4.5);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();                                    // ramp and troops
      ctx.moveTo(cx - 9, cy + 0.5);
      ctx.lineTo(cx - 10, cy - 3.5);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx - 1, cy - 3, 1.8, 0, Math.PI * 2);
      ctx.arc(cx + 4, cy - 2.4, 1.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'airwing': {                           // jet, plan view
      ctx.beginPath();
      ctx.moveTo(cx, cy - 7);
      ctx.lineTo(cx + 1.6, cy - 1.5);
      ctx.lineTo(cx + 9, cy + 1.6);
      ctx.lineTo(cx + 9, cy + 3);
      ctx.lineTo(cx + 1.4, cy + 2);
      ctx.lineTo(cx + 1.1, cy + 5);
      ctx.lineTo(cx + 3.4, cy + 7);
      ctx.lineTo(cx, cy + 6);
      ctx.lineTo(cx - 3.4, cy + 7);
      ctx.lineTo(cx - 1.1, cy + 5);
      ctx.lineTo(cx - 1.4, cy + 2);
      ctx.lineTo(cx - 9, cy + 3);
      ctx.lineTo(cx - 9, cy + 1.6);
      ctx.lineTo(cx - 1.6, cy - 1.5);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'orbital': {                           // satellite on station
      ctx.beginPath();                                    // body
      ctx.ellipse(w / 2, h / 2, 3.2, 3.2, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();                                    // solar wings
      ctx.moveTo(w / 2 - 4, h / 2); ctx.lineTo(w / 2 - 10, h / 2);
      ctx.moveTo(w / 2 + 4, h / 2); ctx.lineTo(w / 2 + 10, h / 2);
      ctx.stroke();
      ctx.strokeRect(w / 2 - 10, h / 2 - 2.6, 4, 5.2);
      ctx.strokeRect(w / 2 + 6, h / 2 - 2.6, 4, 5.2);
      break;
    }
    case 'flotilla': {                          // warship
      ctx.beginPath();                                    // hull
      ctx.moveTo(cx - 10, cy + 2);
      ctx.lineTo(cx + 10, cy + 2);
      ctx.lineTo(cx + 6.5, cy + 5.5);
      ctx.lineTo(cx - 8, cy + 5.5);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();                                    // superstructure
      ctx.moveTo(cx - 4, cy + 2);
      ctx.lineTo(cx - 4, cy - 2.5);
      ctx.lineTo(cx + 2, cy - 2.5);
      ctx.lineTo(cx + 2, cy + 2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();                                    // mast
      ctx.moveTo(cx - 1, cy - 2.5);
      ctx.lineTo(cx - 1, cy - 6.5);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();                                    // forward gun
      ctx.moveTo(cx + 4, cy + 2);
      ctx.lineTo(cx + 8, cy - 0.5);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      break;
    }
  }
}

/** A counter chit, cached per (kind, colour, echelon). */
export function counterCanvas(
  kind: UnitKind, color: string, echelon: Echelon, style: IconStyle = 'nato', ratio = 2,
): HTMLCanvasElement {
  const key = `${kind}|${color}|${echelon}|${style}|${ratio}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const w = W * ratio, h = (H + 8) * ratio;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.scale(ratio, ratio);

  const top = 8;
  // counter body
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(18,14,10,0.95)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(0.6, top + 0.6, W - 1.2, H - 1.2, R);
  ctx.fill();
  ctx.stroke();

  // top light, bottom shadow: reads as a physical chit
  const g = ctx.createLinearGradient(0, top, 0, top + H);
  g.addColorStop(0, shade(color, 0.12));
  g.addColorStop(0.5, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(0.6, top + 0.6, W - 1.2, H - 1.2, R);
  ctx.fill();

  ctx.save();
  ctx.translate(0, top);
  if (style === 'pictorial') drawPicture(ctx, kind, W, H);
  else drawSymbol(ctx, kind, W, H);
  ctx.restore();

  // echelon marker above the counter
  ctx.fillStyle = 'rgba(28,22,16,0.9)';
  ctx.font = `600 ${7}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(ECHELON_MARK[echelon], W / 2, 0.5);

  cache.set(key, cv);
  return cv;
}
