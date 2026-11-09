// diagrams.js — Offline Mermaid & Chart.js engine for GazBoard Visualization Studio
// Invariant: Modular JavaScript frontend, offline-first; heavy native compute offloaded to Rust/native host.

let mermaidPromise = null;
let chartJsPromise = null;

/**
 * Lazy loads Mermaid.js from the vendored bundle.
 * Configures offline rendering with sanitized loose security.
 */
export function loadMermaid() {
  if (typeof window !== 'undefined' && window.mermaid) {
    return Promise.resolve(window.mermaid);
  }
  if (typeof document === 'undefined') return Promise.resolve(null);

  if (!mermaidPromise) {
    mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = './vendor/mermaid.min.js';
      s.onload = () => {
        try {
          if (window.mermaid) {
            window.mermaid.initialize({
              startOnLoad: false,
              theme: 'default',
              securityLevel: 'loose',
              suppressErrorRendering: true,
              fontFamily: 'Segoe UI, -apple-system, system-ui, sans-serif'
            });
          }
          resolve(window.mermaid);
        } catch (err) {
          reject(err);
        }
      };
      s.onerror = (e) => {
        mermaidPromise = null;
        reject(new Error('Mermaid.js failed to load from ./vendor/mermaid.min.js'));
      };
      document.head.appendChild(s);
    });
  }
  return mermaidPromise;
}

/**
 * Lazy loads Chart.js from the vendored bundle.
 */
export function loadChartJs() {
  if (typeof window !== 'undefined' && window.Chart) {
    return Promise.resolve(window.Chart);
  }
  if (typeof document === 'undefined') return Promise.resolve(null);

  if (!chartJsPromise) {
    chartJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = './vendor/chart.umd.min.js';
      s.onload = () => {
        resolve(window.Chart);
      };
      s.onerror = (e) => {
        chartJsPromise = null;
        reject(new Error('Chart.js failed to load from ./vendor/chart.umd.min.js'));
      };
      document.head.appendChild(s);
    });
  }
  return chartJsPromise;
}

/**
 * Validates Mermaid diagram code syntax.
 * @param {string} code
 * @returns {Promise<{ valid: boolean, error: string|null, line?: number }>}
 */
export async function validateMermaid(code) {
  const clean = (code || '').trim();
  if (!clean) return { valid: false, error: 'Empty diagram code' };

  try {
    const mermaid = await loadMermaid();
    if (!mermaid) {
      // In headless node environments where DOM is not mocked, basic header keyword check
      const validHeaders = ['flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'erDiagram', 'journey', 'gantt', 'pie', 'quadrantChart', 'mindmap', 'gitGraph'];
      const firstLine = clean.split('\n')[0].trim().replace(/\s+.*$/, '');
      if (validHeaders.some(h => clean.startsWith(h))) {
        return { valid: true, error: null };
      }
      return { valid: false, error: 'Unrecognized diagram header: ' + firstLine };
    }
    const ok = await mermaid.parse(clean);
    return { valid: !!ok, error: null };
  } catch (err) {
    let line = null;
    if (err.hash && typeof err.hash.line === 'number') {
      line = err.hash.line;
    } else {
      const match = /(?:at line|line\s+)(\d+)/i.exec(err.message || String(err));
      if (match) line = parseInt(match[1], 10);
    }
    const rawError = err.str || err.message || String(err);
    const cleanError = rawError.replace(/^Error:\s*/, '').replace(/Parse error on line \d+:\s*/, '');
    return { valid: false, error: cleanError, line };
  }
}

/**
 * Validates Chart.js JSON configuration string or object.
 * @param {string|object} cfgOrStr
 * @returns {{ valid: boolean, error: string|null, config?: object }}
 */
export function validateChartConfig(cfgOrStr) {
  let cfg = null;
  if (typeof cfgOrStr === 'string') {
    const clean = cfgOrStr.trim();
    if (!clean) return { valid: false, error: 'Empty chart configuration' };
    try {
      cfg = JSON.parse(clean);
    } catch (e) {
      return { valid: false, error: 'Invalid JSON format: ' + e.message };
    }
  } else {
    cfg = cfgOrStr;
  }

  if (!cfg || typeof cfg !== 'object') {
    return { valid: false, error: 'Configuration must be a JSON object' };
  }
  const allowedTypes = ['radar', 'bar', 'line', 'pie', 'doughnut', 'polarArea', 'scatter', 'bubble'];
  if (!cfg.type || !allowedTypes.includes(cfg.type)) {
    return { valid: false, error: `Chart type must be one of: ${allowedTypes.join(', ')}` };
  }
  if (!cfg.data || typeof cfg.data !== 'object') {
    return { valid: false, error: 'Missing "data" object in configuration' };
  }
  if (!Array.isArray(cfg.data.labels)) {
    return { valid: false, error: '"data.labels" must be an array of category names' };
  }
  if (!Array.isArray(cfg.data.datasets) || cfg.data.datasets.length === 0) {
    return { valid: false, error: '"data.datasets" must be a non-empty array' };
  }
  for (let i = 0; i < cfg.data.datasets.length; i++) {
    const ds = cfg.data.datasets[i];
    if (!ds || !Array.isArray(ds.data)) {
      return { valid: false, error: `Dataset [${i}] is missing a "data" array` };
    }
  }

  return { valid: true, error: null, config: cfg };
}

/**
 * Renders Mermaid diagram code into an SVG string and data URL.
 * @param {string} code
 * @param {string} id
 * @returns {Promise<{ svg: string, w: number, h: number, dataUrl: string }>}
 */
export async function renderMermaidSvg(code, id = 'mmd_' + Math.random().toString(36).slice(2, 9)) {
  const mermaid = await loadMermaid();
  if (!mermaid) throw new Error('Mermaid renderer unavailable');

  // Render SVG element
  const res = await mermaid.render(id, code.trim());
  const svg = res.svg;

  // Extract dimensions
  let w = 600, h = 400;
  const vbMatch = /viewBox=["']\s*([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s*["']/i.exec(svg);
  if (vbMatch) {
    w = Math.max(100, Math.ceil(parseFloat(vbMatch[3])));
    h = Math.max(100, Math.ceil(parseFloat(vbMatch[4])));
  } else {
    const wMatch = /width=["']([0-9.]+)px?["']/i.exec(svg);
    const hMatch = /height=["']([0-9.]+)px?["']/i.exec(svg);
    if (wMatch) w = Math.max(100, Math.ceil(parseFloat(wMatch[1])));
    if (hMatch) h = Math.max(100, Math.ceil(parseFloat(hMatch[1])));
  }

  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return { svg, w, h, dataUrl };
}

/**
 * Renders Chart.js configuration into a PNG data URL using an offscreen canvas.
 * @param {object} config
 * @param {number} width
 * @param {number} height
 * @returns {Promise<{ dataUrl: string, w: number, h: number }>}
 */
export async function renderChartDataUrl(config, width = 600, height = 450) {
  const Chart = await loadChartJs();
  if (!Chart) throw new Error('Chart.js engine unavailable');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Ensure synchronous static render without layout animation
  const clonedConfig = JSON.parse(JSON.stringify(config));
  clonedConfig.options = Object.assign({}, clonedConfig.options, {
    responsive: false,
    animation: false,
    maintainAspectRatio: false
  });

  const chart = new Chart(ctx, clonedConfig);
  const dataUrl = canvas.toDataURL('image/png');
  chart.destroy();

  return { dataUrl, w: width, h: height };
}

/* =================================================================== *
 *  Interactive UI Builders (Decision Trees, Mind Maps, Radar Charts)  *
 * =================================================================== */

/**
 * Validates steps in the interactive Flowchart / Decision Tree builder.
 * Returns map of step index / id to validity details.
 */
export function validateFlowchartSteps(steps) {
  const stepIds = new Set(steps.map(s => s.id));
  const results = [];
  let overallValid = true;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const errors = [];
    const textValid = !!(s.text && s.text.trim().length > 0);
    if (!textValid) {
      errors.push('Missing step label / question');
    }

    if (s.kind === 'decision') {
      if (s.yes && !stepIds.has(s.yes) && s.yes !== '__end__') {
        errors.push(`"Yes" target "${s.yes}" does not exist`);
      }
      if (s.no && !stepIds.has(s.no) && s.no !== '__end__') {
        errors.push(`"No" target "${s.no}" does not exist`);
      }
    } else if (s.kind === 'action' || s.kind === 'start') {
      if (s.next && !stepIds.has(s.next) && s.next !== '__end__') {
        errors.push(`Next target "${s.next}" does not exist`);
      }
    }

    const valid = errors.length === 0;
    if (!valid) overallValid = false;

    results.push({
      id: s.id,
      index: i,
      valid,
      textValid,
      errors
    });
  }

  return { valid: overallValid && steps.length > 0, steps: results };
}

/**
 * Synthesizes Mermaid flowchart syntax from builder step models.
 */
export function synthesizeFlowchartMermaid(data) {
  const orientation = data.orientation || 'TD';
  const steps = data.steps || [];
  if (!steps.length) return 'flowchart TD\n  step1["New Process"]';

  const lines = [`flowchart ${orientation}`];

  // Helper to escape labels
  const esc = (t) => (t || '').replace(/"/g, '#quot;').trim();

  // Define nodes
  for (const s of steps) {
    const txt = esc(s.text) || 'Step';
    switch (s.kind) {
      case 'decision':
        lines.push(`  ${s.id}{"${txt}"}`);
        break;
      case 'start':
        lines.push(`  ${s.id}(["${txt}"])`);
        break;
      case 'end':
        lines.push(`  ${s.id}(["${txt}"])`);
        break;
      case 'data':
        lines.push(`  ${s.id}[/"${txt}"/]`);
        break;
      case 'action':
      default:
        lines.push(`  ${s.id}["${txt}"]`);
        break;
    }
  }

  // Define transitions
  for (const s of steps) {
    if (s.kind === 'decision') {
      if (s.yes) {
        if (s.yes === '__end__') {
          lines.push(`  ${s.id} -- Yes --> end_node(["End"])`);
        } else {
          lines.push(`  ${s.id} -- Yes --> ${s.yes}`);
        }
      }
      if (s.no) {
        if (s.no === '__end__') {
          lines.push(`  ${s.id} -- No --> end_node(["End"])`);
        } else {
          lines.push(`  ${s.id} -- No --> ${s.no}`);
        }
      }
    } else if (s.kind !== 'end') {
      if (s.next) {
        if (s.next === '__end__') {
          lines.push(`  ${s.id} --> end_node(["End"])`);
        } else {
          lines.push(`  ${s.id} --> ${s.next}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Synthesizes Mermaid mindmap syntax from hierarchical bullet items.
 */
export function synthesizeMindmapMermaid(data) {
  const rootText = (data.root || 'Central Idea').trim();
  const lines = ['mindmap', `  root(("${rootText.replace(/"/g, '')}"))`];

  const branches = data.branches || [];
  for (const b of branches) {
    const level = Math.max(1, Math.min(5, b.level || 1));
    const indent = '  '.repeat(level + 1);
    const text = (b.text || 'Idea').trim();
    if (text) {
      lines.push(`${indent}${text}`);
    }
  }

  return lines.join('\n');
}

/**
 * Validates radar & statistical chart builder input.
 */
export function validateChartBuilder(data) {
  const errors = [];
  const categories = (data.categories || []).filter(c => c && c.trim().length > 0);
  if (categories.length < 1) {
    errors.push('At least 1 category / label is required');
  }
  if (data.type === 'radar' && categories.length < 3) {
    errors.push('Radar / Spider charts require at least 3 categories for polygon rendering');
  }

  const datasets = data.datasets || [];
  if (datasets.length < 1) {
    errors.push('At least 1 dataset is required');
  }

  const datasetResults = [];
  for (let i = 0; i < datasets.length; i++) {
    const ds = datasets[i];
    const dsErrors = [];
    if (!ds.label || !ds.label.trim()) {
      dsErrors.push('Dataset name is required');
    }
    const nums = (ds.valuesStr || '')
      .split(',')
      .map(v => v.trim())
      .filter(v => v.length > 0)
      .map(Number);

    const hasNaN = nums.some(n => isNaN(n));
    if (hasNaN) {
      dsErrors.push('All values must be valid numbers');
    } else if (nums.length !== categories.length) {
      dsErrors.push(`Values count (${nums.length}) does not match categories count (${categories.length})`);
    }

    datasetResults.push({
      index: i,
      valid: dsErrors.length === 0,
      errors: dsErrors,
      parsedValues: nums
    });
  }

  const datasetsValid = datasetResults.every(d => d.valid);
  return {
    valid: errors.length === 0 && datasetsValid,
    errors,
    datasetResults,
    categories
  };
}

/**
 * Synthesizes Chart.js config object from builder data.
 */
export function synthesizeChartConfig(data) {
  const type = data.type || 'radar';
  const categories = (data.categories || []).map(c => (c || '').trim()).filter(Boolean);
  const datasets = (data.datasets || []).map(ds => {
    const vals = (ds.valuesStr || '')
      .split(',')
      .map(v => parseFloat(v.trim()))
      .filter(v => !isNaN(v));

    const color = ds.color || '#3b82f6';
    let bgColor = color;
    if (type === 'radar') {
      // translucent fill
      bgColor = color.startsWith('#') && color.length === 7 ? color + '33' : 'rgba(59, 130, 246, 0.2)';
    }

    return {
      label: ds.label || 'Dataset',
      data: vals,
      backgroundColor: bgColor,
      borderColor: color,
      borderWidth: 2,
      fill: type === 'radar' ? true : false,
      pointBackgroundColor: color
    };
  });

  return {
    type,
    data: {
      labels: categories,
      datasets
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title: {
          display: !!data.title,
          text: data.title || ''
        },
        legend: {
          position: 'top'
        }
      }
    }
  };
}

/**
 * AI Prompt Generator for 1-Click prompt template copying.
 */
export function getAiPromptTemplate(diagramType = 'flowchart', topic = 'Order Processing Pipeline') {
  if (diagramType === 'chartjs') {
    return `Generate a valid Chart.js configuration JSON object for "${topic}".
Include "type" (one of: radar, bar, line, doughnut), "data.labels" array, and "data.datasets" array with numeric "data" and colors.
Output ONLY the raw JSON configuration inside a single \`\`\`json code block with no markdown preamble or commentary.`;
  }

  if (diagramType === 'mindmap') {
    return `Generate a clean, structured Mermaid.js mindmap diagram for "${topic}".
Use the following format:
\`\`\`mermaid
mindmap
  root(("${topic}"))
    Category 1
      Subtopic 1A
      Subtopic 1B
    Category 2
      Subtopic 2A
\`\`\`
Output ONLY raw valid Mermaid syntax inside a single \`\`\`mermaid code block with no markdown preamble or explanations.`;
  }

  return `Generate a clean, comprehensive Mermaid.js flowchart diagram for "${topic}".
Adhere strictly to Mermaid v10 flowchart syntax:
- Start with \`flowchart TD\` (or \`flowchart LR\`)
- Use semantic node shapes: \`(["Start/End"])\`, \`["Process"]\`, \`{"Decision?"}\`
- Use clean descriptive labels and clear arrows with conditions: \`node1 -- Yes --> node2\`
- Ensure all node IDs are valid alphanumeric identifiers without special characters
Output ONLY raw valid Mermaid code inside a single \`\`\`mermaid code block with no markdown preamble or explanations.`;
}
