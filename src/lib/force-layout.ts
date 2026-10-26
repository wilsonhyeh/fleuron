/**
 * A small force-directed layout for the relationship map. Dependency-free on
 * purpose (the app ships no charting library), and small enough to read: the
 * graphs it lays out are a codebook, tens of nodes, not thousands.
 *
 * Positions persist across `setGraph` calls, so when coding changes the map
 * the existing shape stays put and only what is new moves into place.
 */

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** Pinned while the user drags it. */
  fx: number | null;
  fy: number | null;
}

export interface SimLink {
  source: string;
  target: string;
  /** Rest length. */
  distance: number;
  /** 0..1, how hard the spring pulls. */
  strength: number;
}

export interface SimInput {
  nodes: { id: string; r: number; near?: string[] }[];
  links: SimLink[];
}

const VELOCITY_DECAY = 0.58;
const ALPHA_DECAY = 0.985;
const ALPHA_MIN = 0.003;
const CHARGE = 170;
const GRAVITY = 0.014;
/** Room around each node for its label, so names do not sit on each other. */
const COLLIDE_PAD = 22;

export class ForceSim {
  nodes = new Map<string, SimNode>();
  links: SimLink[] = [];
  alpha = 1;
  /** Width / height of the pane, so the layout grows into the pane's shape. */
  aspect = 1;

  setGraph(input: SimInput) {
    const next = new Map<string, SimNode>();
    let spawned = 0;
    for (const n of input.nodes) {
      const existing = this.nodes.get(n.id);
      if (existing) {
        existing.r = n.r;
        next.set(n.id, existing);
        continue;
      }
      // New nodes enter beside something they are linked to, so a fresh code
      // grows out of its neighbourhood instead of flying in from the middle.
      const anchor = (n.near ?? [])
        .map((id) => next.get(id) ?? this.nodes.get(id))
        .find((a): a is SimNode => Boolean(a));
      const angle = Math.random() * Math.PI * 2;
      const spread = anchor ? anchor.r + n.r + 12 : 40 + Math.sqrt(next.size + spawned) * 30;
      next.set(n.id, {
        id: n.id,
        x: (anchor?.x ?? 0) + Math.cos(angle) * spread,
        y: (anchor?.y ?? 0) + Math.sin(angle) * spread,
        vx: 0,
        vy: 0,
        r: n.r,
        fx: null,
        fy: null,
      });
      spawned++;
    }
    const changed = spawned > 0 || next.size !== this.nodes.size || input.links.length !== this.links.length;
    this.nodes = next;
    this.links = input.links.filter((l) => next.has(l.source) && next.has(l.target));
    // Reheat only as much as the change needs: a first layout settles from
    // scratch, a new code nudges its neighbourhood, a strengthened link barely
    // moves anything — the map should not rearrange itself while you code.
    const target = spawned > 0 && next.size === spawned ? 1 : spawned > 0 ? 0.4 : changed ? 0.2 : 0.08;
    this.alpha = Math.max(this.alpha, target);
  }

  reheat(alpha = 0.4) {
    this.alpha = Math.max(this.alpha, alpha);
  }

  get running() {
    return this.alpha > ALPHA_MIN;
  }

  tick() {
    if (!this.running) return false;
    const list = [...this.nodes.values()];
    const a = this.alpha;

    // Many-body repulsion and collision, pairwise: fine at codebook scale.
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const q = list[j];
        let dx = q.x - p.x;
        let dy = q.y - p.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        // Falls off with distance (not its square), so the layout spreads to
        // fill its pane instead of balling up around the hubs.
        const charge = (CHARGE * a * (p.r + q.r)) / 30 / Math.max(d, 8);
        const fx = (dx / d) * charge;
        const fy = (dy / d) * charge;
        p.vx -= fx;
        p.vy -= fy;
        q.vx += fx;
        q.vy += fy;
        const pad = p.r < 6 || q.r < 6 ? 4 : COLLIDE_PAD;
        const min = p.r + q.r + pad;
        if (d < min) {
          const push = ((min - d) / d) * 0.5;
          p.x -= dx * push;
          p.y -= dy * push;
          q.x += dx * push;
          q.y += dy * push;
        }
      }
    }

    for (const l of this.links) {
      const s = this.nodes.get(l.source)!;
      const t = this.nodes.get(l.target)!;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const k = ((d - l.distance) / d) * l.strength * a * 0.5;
      s.vx += dx * k;
      s.vy += dy * k;
      t.vx -= dx * k;
      t.vy -= dy * k;
    }

    const gx = GRAVITY * a * Math.pow(this.aspect, -0.9);
    const gy = GRAVITY * a * Math.pow(this.aspect, 0.9);
    for (const n of list) {
      n.vx -= n.x * gx;
      n.vy -= n.y * gy;
      if (n.fx != null && n.fy != null) {
        n.x = n.fx;
        n.y = n.fy;
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= VELOCITY_DECAY;
      n.vy *= VELOCITY_DECAY;
      n.x += n.vx;
      n.y += n.vy;
    }

    this.alpha *= ALPHA_DECAY;
    return true;
  }

  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.nodes.size === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of this.nodes.values()) {
      minX = Math.min(minX, n.x - n.r);
      minY = Math.min(minY, n.y - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }
    return { minX, minY, maxX, maxY };
  }
}
