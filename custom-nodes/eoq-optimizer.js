/**
 * Inventory Optimization Planner — Economic Order Quantity (EOQ).
 *
 * Pedagogical purpose
 * -------------------
 * EOQ (Wilson, 1934) is the canonical *classical* operations-research model:
 * a closed-form solution under strict assumptions —
 *   - constant demand
 *   - instantaneous replenishment
 *   - no stockouts allowed
 *   - fixed ordering cost, fixed holding cost
 *   - no quantity discounts
 *
 * Real e-commerce violates ALL of these for at least some SKUs. Viral
 * products (looking at you, SKU-007) blow past "constant demand." Discontinued
 * SKUs (SKU-013) make "no stockouts" expensive in the wrong direction.
 * Slow-movers make the formula numerically unstable.
 *
 * This node teaches the boundary problem: classical algorithms give crisp
 * answers exactly when their assumptions hold. The two pieces implemented here are
 *   (a) implement the formula
 *   (b) detect when its assumptions don't hold for a given SKU
 *
 * The downstream LLM exception node handles the SKUs you flag.
 *
 * Reading: docs/planning-primer.md §"STRIPS-style assumptions and where they break"
 */

// This node's direct input is the Master Planner's plan item (via the Switch),
// so the rows are read by node name: inventory rows ("Read Inventory JSON")
// and sales rows ("Read Sales JSON") are combined into one heterogeneous list.
// Partition them by which fields are present.
// CSV values arrive as strings: units_sold is converted to a number here;
// inventory fields (on_hand, lead_time_days, ...) still need Number().
const all = [
  ...$('Read Inventory JSON').all().map(i => i.json),
  ...$('Read Sales JSON').all()
    .map(i => ({ ...i.json, units_sold: Number(i.json.units_sold) })),
];

// Default ordering cost (S in the EOQ formula). In production this would
// vary by supplier and channel; we hard-code a single value so the focus
// stays on the formula and its assumptions.
const ORDERING_COST_USD = 50;

// ---- Helpers (provided) ---------------------------------------------------

function partition(rows) {
  const inventory = rows.filter(r => "on_hand" in r);
  const sales = rows.filter(r => "units_sold" in r);
  return { inventory, sales };
}

function annualDemand(salesForSku) {
  // Sum units_sold across the rows we have. With 12 months of data this is
  // the trailing-12-months annual demand.
  return salesForSku.reduce((acc, r) => acc + Number(r.units_sold), 0);
}

// ---- 1. The EOQ formula ---------------------------------------------------

/**
 * Wilson's Economic Order Quantity:
 *
 *   Q* = sqrt( (2 * D * S) / H )
 *
 * @param {number} D  Annual demand        (units per year)
 * @param {number} S  Fixed cost per order (dollars per order)
 * @param {number} H  Holding cost         (dollars per unit per year)
 * @returns {number}  Optimal order quantity, rounded to nearest integer.
 *
 * Hint: Math.sqrt is your friend. Guard against D=0 and H=0 — return 0 in
 *       either case. (You can't optimally order anything for zero demand,
 *       and dividing by zero holding cost is meaningless.)
 */
function eoq(D, S, H) {
  // Q* = sqrt(2DS / H). Zero demand or zero holding cost -> no meaningful batch.
  if (!(D > 0) || !(H > 0)) return 0;
  return Math.round(Math.sqrt((2 * D * S) / H));
}

// ---- 2. Assumption-violation detection ------------------------------------

/**
 * EOQ assumes:
 *   (a) demand is roughly constant
 *   (b) lead time is short enough to re-order before stocking out
 *   (c) the SKU isn't perishable (no holding-cost cliff)
 *   (d) demand volume is high enough that an "optimal batch" is meaningful
 *
 * Return an array of human-readable flag strings for any assumption that
 * FAILS for this SKU. An empty array means "EOQ is trustworthy here, ship
 * the formula's recommendation."
 *
 * Suggested checks (refine as you wish):
 *   - "viral_spike"   : mean(last 3 months) > 2.5 × mean(prior 9 months)
 *   - "declining"     : mean(last 3 months) < 0.5 × mean(first 3 months)
 *   - "low_velocity"  : annualDemand < 60   (less than ~5/month average)
 *   - "long_lead_time": inv.lead_time_days > 28 AND demand is volatile
 *
 * Note on perishability: none of our demo SKUs are perishable, so you do
 * NOT need a perishability check. Document the omission in your analysis
 * write-up — a real implementation would need it.
 *
 * @param {object} inv         Inventory row for the SKU
 * @param {Array}  salesSeries Chronologically sorted sales rows for the SKU
 * @returns {Array<string>}    Flag names, e.g. ["viral_spike", "low_velocity"]
 *
 * Hint: implement each check as its own small block. A flagged SKU may
 *       trigger multiple flags — that's expected and useful downstream.
 */
function detectViolations(inv, salesSeries) {
  const units = salesSeries.map(r => Number(r.units_sold));
  if (units.length === 0) return ["no_sales_history"];

  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const last3 = mean(units.slice(-3));
  const prior9 = mean(units.slice(0, -3));
  const first3 = mean(units.slice(0, 3));
  const annual = units.reduce((s, x) => s + x, 0);
  const flags = [];

  // (a) Constant demand -- surge. Seasonal winter SKUs also triple in Q4, so a
  // ratio alone would flag them; a viral SKU additionally breaks through its
  // own previous peak (latest month > 2x the highest of the earlier months).
  const priorPeak = Math.max(...units.slice(0, -3));
  if (prior9 > 0 && last3 > 2.5 * prior9 && units[units.length - 1] > 2 * priorPeak) {
    flags.push("viral_spike");
  }

  // (a) Constant demand -- structural decline (not a seasonal dip).
  if (first3 > 0 && last3 < 0.5 * first3) flags.push("declining");

  // (d) Volume too low for an "optimal batch" to mean anything.
  if (annual < 60) flags.push("low_velocity");

  // (b) Long lead time combined with volatile demand: by the time a
  // reorder lands, demand may be very different from the average EOQ used.
  const m = mean(units);
  const sd = Math.sqrt(mean(units.map(x => (x - m) ** 2)));
  const cv = m > 0 ? sd / m : 0;
  if (Number(inv.lead_time_days) > 28 && cv > 0.5) flags.push("long_lead_time");

  // (c) Perishability: not checked -- no demo SKU is perishable (see analysis.md).
  return flags;
}

// ---- Main loop (provided) -------------------------------------------------

const { inventory, sales } = partition(all);
const salesBySku = sales.reduce((acc, r) => {
  (acc[r.sku] = acc[r.sku] || []).push(r);
  return acc;
}, {});
for (const sku of Object.keys(salesBySku)) {
  salesBySku[sku].sort((a, b) => a.month.localeCompare(b.month));
}

const results = [];
for (const inv of inventory) {
  const series = salesBySku[inv.sku] || [];
  const D = annualDemand(series);
  const H = Number(inv.holding_cost_per_unit_year);
  const Q = eoq(D, ORDERING_COST_USD, H);
  const flags = detectViolations(inv, series);

  results.push({
    sku: inv.sku,
    name: inv.name,
    on_hand: Number(inv.on_hand),
    reorder_point: Number(inv.reorder_point),
    lead_time_days: Number(inv.lead_time_days),
    recent_units: series.slice(-6).map(r => Number(r.units_sold)),
    annual_demand: D,
    eoq_units: Q,
    holding_cost_per_unit_year: H,
    ordering_cost_usd: ORDERING_COST_USD,
    assumption_flags: flags,
    needs_llm_review: flags.length > 0,
  });
}

return results.map(r => ({ json: r }));
