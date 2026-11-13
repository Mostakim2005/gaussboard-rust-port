/**
 * Interactive Knowledge Graph View for GazBoard.
 * Force-directed network visualizer showing boards, tags, wikilinks, and excerpts as interactive nodes.
 */

import { h } from './popover.js';
import { t } from '../i18n.js';

export class GraphViewModal {
  constructor(app) {
    this.app = app;
    this.nodes = [];
    this.edges = [];
    this.animId = null;
    this.running = app.settings?.graphPhysics !== false;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.isDragging = false;
    this.draggedNode = null;
    this.hoveredNode = null;
    this.lastMouse = { x: 0, y: 0 };
    this.searchQuery = '';
    this.clustering = true;
    this.communities = [];
    this.el = null;
    this.canvas = null;
    this.ctx = null;
  }

  detectCommunities() {
    const adj = new Map();
    for (const n of this.nodes) adj.set(n.id, []);
    for (const e of this.edges) {
      if (adj.has(e.from)) adj.get(e.from).push(e.to);
      if (adj.has(e.to)) adj.get(e.to).push(e.from);
    }

    const visited = new Set();
    const communities = [];
    const colors = [
      { fill: 'rgba(0, 229, 255, 0.08)', stroke: 'rgba(0, 229, 255, 0.35)' },
      { fill: 'rgba(255, 152, 0, 0.08)', stroke: 'rgba(255, 152, 0, 0.35)' },
      { fill: 'rgba(81, 207, 102, 0.08)', stroke: 'rgba(81, 207, 102, 0.35)' },
      { fill: 'rgba(218, 119, 242, 0.08)', stroke: 'rgba(218, 119, 242, 0.35)' },
      { fill: 'rgba(77, 171, 247, 0.08)', stroke: 'rgba(77, 171, 247, 0.35)' },
      { fill: 'rgba(255, 107, 107, 0.08)', stroke: 'rgba(255, 107, 107, 0.35)' }
    ];

    let colorIdx = 0;
    const nodeMap = new Map(this.nodes.map(n => [n.id, n]));

    for (const n of this.nodes) {
      if (visited.has(n.id)) continue;
      const queue = [n.id];
      visited.add(n.id);
      const comp = [];

      while (queue.length > 0) {
        const curr = queue.shift();
        const nodeObj = nodeMap.get(curr);
        if (nodeObj) comp.push(nodeObj);
        const neighbors = adj.get(curr) || [];
        for (const nbr of neighbors) {
          if (!visited.has(nbr)) {
            visited.add(nbr);
            queue.push(nbr);
          }
        }
      }

      if (comp.length > 0) {
        const palette = colors[colorIdx % colors.length];
        colorIdx++;
        communities.push({
          id: `comm_${communities.length + 1}`,
          nodes: comp,
          haloColor: palette.fill,
          strokeColor: palette.stroke,
          cx: 0,
          cy: 0,
          radius: 0
        });
      }
    }
    this.communities = communities;
    this.updateCommunityBounds();
  }

  updateCommunityBounds() {
    for (const c of this.communities) {
      if (!c.nodes.length) continue;
      let sumX = 0, sumY = 0;
      for (const n of c.nodes) {
        sumX += n.x;
        sumY += n.y;
      }
      c.cx = sumX / c.nodes.length;
      c.cy = sumY / c.nodes.length;
      let maxDist = 0;
      for (const n of c.nodes) {
        const d = Math.hypot(n.x - c.cx, n.y - c.cy) + (n.radius || 12);
        if (d > maxDist) maxDist = d;
      }
      c.radius = maxDist;
    }
  }

  async buildGraphData() {
    const nodes = [];
    const edges = [];
    const nodeMap = new Map();

    const addNode = (id, label, type, color, radius = 12, meta = {}) => {
      if (nodeMap.has(id)) return nodeMap.get(id);
      const angle = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 220;
      const node = {
        id,
        label,
        type, // 'board' | 'tag' | 'excerpt'
        color,
        radius,
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
        vx: 0,
        vy: 0,
        meta
      };
      nodes.push(node);
      nodeMap.set(id, node);
      return node;
    };

    const addEdge = (fromId, toId, kind = 'link') => {
      if (!fromId || !toId || fromId === toId) return;
      const exists = edges.some(e => (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId));
      if (!exists) {
        edges.push({ from: fromId, to: toId, kind });
      }
    };

    // 1. Current active board
    const currentId = this.app.store?.id || 'current';
    const currentName = this.app.store?.name || t('Active Board');
    const currentNode = addNode(currentId, currentName, 'board', '#00e5ff', 16, { active: true });

    // 2. Scan current board tags
    const docTags = Array.isArray(this.app.store?.doc?.tags) ? this.app.store.doc.tags : [];
    for (const tag of docTags) {
      const tagId = `tag_${tag.toLowerCase()}`;
      addNode(tagId, `#${tag}`, 'tag', '#ff9800', 10);
      addEdge(currentId, tagId, 'tag');
    }

    // 3. Scan objects on current board for inline tags, wikilinks, and excerpts
    const objects = this.app.store?.doc?.objects || {};
    for (const o of Object.values(objects)) {
      if (!o) continue;
      // Inline tags
      if (typeof o.text === 'string') {
        const matches = o.text.match(/(?:^|\s)#([a-zA-Z0-9_\-]+)/g);
        if (matches) {
          for (const m of matches) {
            const tag = m.trim().replace(/^#/, '');
            const tagId = `tag_${tag.toLowerCase()}`;
            addNode(tagId, `#${tag}`, 'tag', '#ff9800', 10);
            addEdge(currentId, tagId, 'tag');
          }
        }
        // Wikilinks [[Target]]
        const wlMatches = o.text.match(/\[\[([^\]|#\n]+)/g);
        if (wlMatches) {
          for (const raw of wlMatches) {
            const targetName = raw.replace(/^\[\[/, '').trim();
            if (targetName) {
              const targetId = `wl_${targetName.toLowerCase()}`;
              addNode(targetId, targetName, 'board', '#4dabf7', 12);
              addEdge(currentId, targetId, 'wikilink');
            }
          }
        }
      }

      // Excerpt sources
      if (o.excerptSource?.boardId) {
        const srcId = o.excerptSource.boardId;
        const srcName = o.excerptSource.boardName || t('Source Board');
        addNode(srcId, srcName, 'excerpt', '#51cf66', 12);
        addEdge(currentId, srcId, 'excerpt');
      }
    }

    // 4. Query recent boards catalog if available
    try {
      const recentList = await this.app.storage?.listRecent?.() || [];
      for (const b of recentList.slice(0, 25)) {
        if (!b?.id || b.id === currentId) continue;
        const bNode = addNode(b.id, b.name || t('Board'), 'board', '#339af0', 13);
        if (Array.isArray(b.tags)) {
          for (const tag of b.tags) {
            const tagId = `tag_${tag.toLowerCase()}`;
            addNode(tagId, `#${tag}`, 'tag', '#ff9800', 10);
            addEdge(b.id, tagId, 'tag');
          }
        }
      }
    } catch (_) {
      // offline fallback
    }

    // 5. Merge indexed backlinks from Rust SQLite / fallback search graph
    if (this.app?.settings?.enableObsidianProtocol !== false && window.board?.search?.getBacklinks) {
      try {
        const backlinks = await window.board.search.getBacklinks(currentId);
        if (Array.isArray(backlinks)) {
          for (const bl of backlinks) {
            if (!bl?.source_board_id || bl.source_board_id === currentId) continue;
            addNode(bl.source_board_id, bl.source_title || bl.source_board_id, 'board', '#4dabf7', 13);
            addEdge(bl.source_board_id, currentId, bl.edge_type || 'wikilink');
          }
        }
      } catch (_) {}
    }

    this.nodes = nodes;
    this.edges = edges;
  }

  open() {
    this.buildGraphData().then(() => {
      this.detectCommunities();
      this.renderModal();
      this.startSimulation();
    });
  }

  renderModal() {
    this.close();

    const titleEl = h('div', { style: 'font-weight:700;font-size:16px;display:flex;align-items:center;gap:8px;' },
      h('span', { style: 'color:#00e5ff;' }, '🕸️'),
      h('span', {}, t('Knowledge Graph View'))
    );

    const countBadge = h('span', {
      style: 'font-size:12px;background:rgba(255,255,255,0.08);padding:3px 8px;border-radius:12px;color:var(--text-3,rgba(255,255,255,0.6));'
    }, `${this.nodes.length} ${t('nodes')} · ${this.edges.length} ${t('links')}`);

    const searchInput = h('input', {
      type: 'text',
      placeholder: t('Filter nodes…'),
      style: 'background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px 10px;color:inherit;font-size:13px;width:150px;'
    });
    searchInput.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase().trim();
    });

    const togglePhysicsBtn = h('button', {
      class: 'btn btn-ghost',
      style: 'padding:4px 8px;font-size:12px;'
    }, this.running ? t('Freeze') : t('Unfreeze'));
    togglePhysicsBtn.addEventListener('click', () => {
      this.running = !this.running;
      togglePhysicsBtn.textContent = this.running ? t('Freeze') : t('Unfreeze');
      if (this.running) this.startSimulation();
    });

    const toggleClusteringBtn = h('button', {
      class: `btn btn-ghost ${this.clustering ? 'active' : ''}`,
      style: 'padding:4px 8px;font-size:12px;'
    }, this.clustering ? t('Clusters ON') : t('Clusters OFF'));
    toggleClusteringBtn.addEventListener('click', () => {
      this.clustering = !this.clustering;
      toggleClusteringBtn.textContent = this.clustering ? t('Clusters ON') : t('Clusters OFF');
      toggleClusteringBtn.classList.toggle('active', this.clustering);
    });

    const resetZoomBtn = h('button', {
      class: 'btn btn-ghost',
      style: 'padding:4px 8px;font-size:12px;',
      title: t('Reset view')
    }, '⟲');
    resetZoomBtn.addEventListener('click', () => {
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
    });

    const closeBtn = h('button', {
      class: 'btn btn-ghost',
      style: 'font-size:16px;line-height:1;padding:4px 10px;',
      title: t('Close (Esc)')
    }, '✕');
    closeBtn.addEventListener('click', () => this.close());

    const header = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.1);'
    },
      h('div', { style: 'display:flex;align-items:center;gap:12px;' }, titleEl, countBadge),
      h('div', { style: 'display:flex;align-items:center;gap:8px;' }, searchInput, togglePhysicsBtn, toggleClusteringBtn, resetZoomBtn, closeBtn)
    );

    this.canvas = h('canvas', {
      style: 'width:100%;height:100%;display:block;cursor:grab;'
    });

    const canvasContainer = h('div', {
      style: 'flex:1;position:relative;overflow:hidden;background:#0d1117;'
    }, this.canvas);

    const legend = h('div', {
      style: 'padding:8px 16px;border-top:1px solid rgba(255,255,255,0.08);display:flex;gap:16px;font-size:12px;color:rgba(255,255,255,0.65);'
    },
      h('div', { style: 'display:flex;align-items:center;gap:6px;' },
        h('span', { style: 'width:10px;height:10px;border-radius:50%;background:#00e5ff;' }),
        h('span', {}, t('Current Board'))
      ),
      h('div', { style: 'display:flex;align-items:center;gap:6px;' },
        h('span', { style: 'width:10px;height:10px;border-radius:50%;background:#4dabf7;' }),
        h('span', {}, t('Referenced Boards'))
      ),
      h('div', { style: 'display:flex;align-items:center;gap:6px;' },
        h('span', { style: 'width:10px;height:10px;border-radius:50%;background:#ff9800;' }),
        h('span', {}, t('Tags (#)'))
      ),
      h('div', { style: 'display:flex;align-items:center;gap:6px;' },
        h('span', { style: 'width:10px;height:10px;border-radius:50%;background:#51cf66;' }),
        h('span', {}, t('Excerpts'))
      ),
      h('div', { style: 'margin-left:auto;font-style:italic;' }, t('Click node to navigate · Drag to arrange'))
    );

    const dialog = h('div', {
      class: 'modal-glass',
      style: 'width:90vw;max-width:980px;height:80vh;max-height:720px;display:flex;flex-direction:column;border-radius:12px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.15);'
    }, header, canvasContainer, legend);

    this.el = h('div', {
      class: 'modal-backdrop',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:9999;'
    }, dialog);

    document.body.appendChild(this.el);

    // Setup Canvas Resolution
    this.ctx = this.canvas.getContext('2d');
    const updateSize = () => {
      const rect = canvasContainer.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
    };
    updateSize();

    // Setup Listeners
    this.setupInteractions();

    this._onKeyDown = (e) => {
      if (e.key === 'Escape') {
        this.close();
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  setupInteractions() {
    const toWorld = (cx, cy) => {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = (cx - rect.left) * dpr;
      const y = (cy - rect.top) * dpr;
      const centerW = this.canvas.width / 2;
      const centerH = this.canvas.height / 2;
      return {
        x: (x - centerW - this.panX) / this.zoom,
        y: (y - centerH - this.panY) / this.zoom
      };
    };

    const findNodeAt = (wx, wy) => {
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        const n = this.nodes[i];
        const dx = n.x - wx;
        const dy = n.y - wy;
        if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) {
          return n;
        }
      }
      return null;
    };

    this.canvas.addEventListener('mousedown', (e) => {
      const w = toWorld(e.clientX, e.clientY);
      const hit = findNodeAt(w.x, w.y);
      if (hit) {
        this.draggedNode = hit;
      } else {
        this.isDragging = true;
      }
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });

    this._onMouseMove = (e) => {
      if (!this.el) return;
      const w = toWorld(e.clientX, e.clientY);

      if (this.draggedNode) {
        this.draggedNode.x = w.x;
        this.draggedNode.y = w.y;
        this.draggedNode.vx = 0;
        this.draggedNode.vy = 0;
      } else if (this.isDragging) {
        const dpr = window.devicePixelRatio || 1;
        this.panX += (e.clientX - this.lastMouse.x) * dpr;
        this.panY += (e.clientY - this.lastMouse.y) * dpr;
        this.lastMouse = { x: e.clientX, y: e.clientY };
      } else {
        this.hoveredNode = findNodeAt(w.x, w.y);
        this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
      }
    };
    window.addEventListener('mousemove', this._onMouseMove);

    this._onMouseUp = () => {
      this.draggedNode = null;
      this.isDragging = false;
    };
    window.addEventListener('mouseup', this._onMouseUp);

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
      this.zoom = Math.max(0.2, Math.min(4.0, this.zoom * zoomFactor));
    });

    this.canvas.addEventListener('click', (e) => {
      const w = toWorld(e.clientX, e.clientY);
      const hit = findNodeAt(w.x, w.y);
      if (hit && hit.type === 'board' && !hit.meta?.active) {
        // Open the clicked board!
        this.close();
        if (hit.id.startsWith('wl_')) {
          this.app.toast?.(t('Board linked via wikilink: {name}', { name: hit.label }));
        } else {
          this.app.openBoard?.(hit.id);
        }
      }
    });
  }

  startSimulation() {
    if (this.animId) cancelAnimationFrame(this.animId);

    const step = () => {
      if (this.running) {
        this.updatePhysics();
      }
      this.draw();
      if (this.el) {
        this.animId = requestAnimationFrame(step);
      }
    };
    this.animId = requestAnimationFrame(step);
  }

  updatePhysics() {
    const kRepel = 2400;
    const kSpring = 0.045;
    const l0 = 70;
    const damping = 0.88;
    const gravity = 0.008;

    // Repulsion
    for (let i = 0; i < this.nodes.length; i++) {
      const n1 = this.nodes[i];
      for (let j = i + 1; j < this.nodes.length; j++) {
        const n2 = this.nodes[j];
        const dx = n2.x - n1.x;
        const dy = n2.y - n1.y;
        const distSq = Math.max(25, dx * dx + dy * dy);
        const dist = Math.sqrt(distSq);
        const f = kRepel / distSq;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;

        n1.vx -= fx;
        n1.vy -= fy;
        n2.vx += fx;
        n2.vy += fy;
      }
    }

    // Spring Attraction
    const nodeMap = new Map(this.nodes.map(n => [n.id, n]));
    for (const edge of this.edges) {
      const n1 = nodeMap.get(edge.from);
      const n2 = nodeMap.get(edge.to);
      if (!n1 || !n2) continue;

      const dx = n2.x - n1.x;
      const dy = n2.y - n1.y;
      const dist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
      const delta = dist - l0;
      const f = delta * kSpring;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;

      n1.vx += fx;
      n1.vy += fy;
      n2.vx -= fx;
      n2.vy -= fy;
    }

    // Center Gravity and Integration
    for (const n of this.nodes) {
      if (n === this.draggedNode) continue;
      n.vx -= n.x * gravity;
      n.vy -= n.y * gravity;
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  draw() {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2 + this.panX, h / 2 + this.panY);
    ctx.scale(this.zoom, this.zoom);

    const nodeMap = new Map(this.nodes.map(n => [n.id, n]));

    // Draw Community Clustering Halos
    if (this.clustering && Array.isArray(this.communities)) {
      this.updateCommunityBounds();
      for (const comm of this.communities) {
        if (comm.nodes.length < 2) continue;
        ctx.save();
        ctx.beginPath();
        ctx.arc(comm.cx, comm.cy, comm.radius + 18, 0, Math.PI * 2);
        ctx.fillStyle = comm.haloColor;
        ctx.fill();
        ctx.strokeStyle = comm.strokeColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Draw Edges
    for (const edge of this.edges) {
      const n1 = nodeMap.get(edge.from);
      const n2 = nodeMap.get(edge.to);
      if (!n1 || !n2) continue;

      const isConnected = this.hoveredNode && (this.hoveredNode.id === n1.id || this.hoveredNode.id === n2.id);
      ctx.beginPath();
      ctx.moveTo(n1.x, n1.y);
      ctx.lineTo(n2.x, n2.y);
      ctx.strokeStyle = isConnected ? 'rgba(0, 229, 255, 0.85)' : 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = isConnected ? 2.5 : 1;
      ctx.stroke();
    }

    // Draw Nodes
    for (const n of this.nodes) {
      const isHovered = this.hoveredNode === n;
      const isMatch = !this.searchQuery || n.label.toLowerCase().includes(this.searchQuery);

      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius + (isHovered ? 3 : 0), 0, Math.PI * 2);
      ctx.fillStyle = isMatch ? n.color : 'rgba(100, 100, 100, 0.4)';
      ctx.fill();

      if (isHovered || n.meta?.active) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = isHovered ? 3 : 2;
        ctx.stroke();
      }

      // Label
      if (this.zoom >= 0.7 || isHovered || isMatch) {
        ctx.font = `${isHovered ? 'bold ' : ''}11px sans-serif`;
        ctx.fillStyle = isMatch ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.3)';
        ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y + n.radius + 14);
      }
    }

    ctx.restore();
  }

  close() {
    if (this.animId) cancelAnimationFrame(this.animId);
    this.animId = null;
    if (this._onKeyDown) {
      window.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
    if (this._onMouseMove) {
      window.removeEventListener('mousemove', this._onMouseMove);
      this._onMouseMove = null;
    }
    if (this._onMouseUp) {
      window.removeEventListener('mouseup', this._onMouseUp);
      this._onMouseUp = null;
    }
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}
