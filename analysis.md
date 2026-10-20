# Assignment 3 Analysis: Supply Chain Manager

**Name:** Ying Chen
**Model:** Claude Sonnet 4.6 (unchanged from the starter)

---

## 4.1 Algorithm comparison

**SKU-007 (Wool Gloves), the viral case.** The classical baseline for January 2026 is 354 units: a 3-month moving average of 376.7 (Oct–Dec sales of 218, 394 and 518) multiplied by a seasonal index of 0.94 (last January's 131 units divided by the 12-month mean). Both numbers come only from history. The moving average lags a fast trend because it gives October's 218 the same weight as December's 518, and the seasonal index pulls the result down further because last January was an ordinary month for this product. The model assumes demand is roughly stable, and for a viral SKU that assumption fails, so the forecast ends up below the most recent month.

The Forecast Context Adjuster revised the forecast to 460 (+29.9%). It received the last six months of sales (20, 25, 100, 218, 394, 518) and found the surge signal in my prompt: three rises in a row, the latest month more than twice the value three months earlier, and a forecast below the latest month. It also flagged low statistical confidence (0.25). Interestingly, it stopped at about +30% even though the rules allowed a larger revision, so the LLM was more cautious than the prompt required.

I would size the next reorder on 460. 354 ignores a trend that is clearly real; 518 assumes the surge continues at full speed, which is risky for a viral product whose demand can fall as fast as it rose. 460 balances the history against the latest signal.

**SKU-011 (Stainless Bottle), the well-behaved case.** Sales stay between 74 and 78 every month, so the moving average (76) times the seasonal index (0.98) gives 75, with a statistical confidence of 0.97. The LLM found no surge, decline or volatility and kept 75 (0% change). When demand is close to its average, the classical model's assumptions hold and the LLM has nothing to add. That is the behaviour I want: the LLM should step in only where the math breaks.

## 4.2 EOQ assumption analysis

`detectViolations()` implements four checks. A flagged SKU skips the formula's answer and goes to the Inventory Exception Handler.

- **viral_spike**: the last-3-month mean is more than 2.5× the prior 9 months, *and* the latest month is more than 2× the highest earlier month. Triggered by SKU-007 (518 in December vs. a previous peak of 131). EOQ suggested 431; the LLM recommended an emergency reorder of 1,018 (518/30 × (30-day lead time + 30 days) − 18 on hand). I agree: only 18 units are left and real sales are 518 a month. The second condition matters because a ratio alone would also flag the winter SKUs, whose Q4 sales triple but only return to last winter's level. A spike should not be judged on a short window without the long-term history.
- **declining**: the last-3-month mean is under half of the first 3 months. Triggered by SKU-013. EOQ still recommended ordering 397 units with 540 on hand, about 14 months of supply at 38 a month. The LLM said do not reorder and mark down 464 units. I agree with not reordering, but only partly with the markdown: earbuds are not perishable, so there is no urgency to clear them. I would hold and mark down only if the decline continues.
- **long_lead_time**: lead time over 28 days and a coefficient of variation over 0.5. Triggered by SKU-009 (42 days). The rule said hold (75 on hand, reorder point 35), but the LLM reordered 160 because December sales were 187. I agree: including lead time keeps supply stable and prevents overselling.
- **low_velocity**: annual demand under 60 units. No demo SKU triggers it.
- **Perishability** is not checked because no demo SKU is perishable; a real system would need it.

## 4.3 Supplier rubric defense

I assumed a direct-to-consumer online shop selling seasonal goods. The weights are reliability 35, lead time 25, quality 25 and cost 15 (total 100). Reliability is highest because a product that misses its season cannot be sold at any price: gloves that arrive in February have already lost their demand. Cost, measured by payment terms, matters least for the same reason. A hospital supply chain would weight differently: I would put quality (defect rate) first, because a defective medical product is a safety risk, and on-time delivery second.

Each dimension is scaled linearly from 0 to 100, and the tiers are 75+ preferred, 60–75 approved, 45–60 watch, and under 45 deprioritize. The LLM's scores matched my hand calculation exactly.

The top supplier is SUP-001 GreenLeaf at 79.3 (97% on time, 7-day lead time, 0.8% defects; its weakest point is 30-day payment terms). The bottom is SUP-002 Pacific Rim at 39.3 (84% on time, 28 days, 2.2% defects), despite the best payment terms (60 days). This matches my intuition: for seasonal goods, on-time delivery and low defects are what guarantee sales.

One tension: SUP-002 supplies the viral SKU-007, which needs a 1,018-unit emergency order. I would still order from SUP-002, using its long payment terms to fund a large order, because a big stock buffer can absorb late deliveries. The risk is that a late shipment misses the peak of the trend, so this order needs close tracking.

## 4.4 Run metrics

| Branch | Wall-clock | LLM calls | Tokens (in + out) | Cost (Sonnet 4.6, $3/$15 per M) |
|---|---|---|---|---|
| forecast | 17.4 s | 16 | 10,696 + 2,366 | $0.068 |
| inventory | 13.0 s | 16 | 11,714 + 1,930 | $0.064 |
| supplier | 25.6 s | 2 | 2,538 + 1,802 | $0.035 |
| logistics | 17.8 s | 4 | 6,579 + 2,367 | $0.055 |

All four branches stayed under $0.10 per run. Token and cost figures are summed automatically in the Final Output node from each LLM response's `usage` field.

Two things surprised me. First, the LLM did not always follow instructions: in my first version, 10 of 15 forecast replies started with "Let me analyze…" before the JSON, so they could not be parsed. Requiring the reply to start with `{` and making the parser find the JSON fixed it (0 errors afterwards), but this is the biggest risk to taking such a plan into production. Second, the same goal produced two different plan orders on two runs (forecast→inventory→supplier vs. forecast→supplier→inventory). A planner that changes its answer is not acceptable for a real project; setting temperature to 0 or validating the order in code would be my next fix.

## 4.5 Reflection on the primer questions

**Where the LLM helped and where code had to catch it.** The LLM added value where history broke: for SKU-007 it read the three-month surge and raised the forecast from 354 to 460, which the moving average could not do. But it also failed in ways code never does: in my first run, 10 of 15 replies ignored the "JSON only" instruction. Classical code cannot decide to disobey, so it acts as the guardrail: the parser, the hard constraints in logistics, and the violation flags.

**Unknown subgoal.** If the planner returned a subgoal the Switch does not know, no branch would match, and the run would still show "Succeeded" with nothing done, a silent failure. I would add a Switch fallback output that routes to an error node, and validate `next_subgoal` against the four allowed values in Parse Plan.

**Confidently wrong math.** EOQ assumes constant demand. For the declining SKU-013 it still recommended 397 units with 14 months of stock on hand. The formula looks precise, but the assumption behind it is broken.

**Where I would add human review.** A wrong supplier score lowers quality but does not stop the business. A wrong reorder quantity directly ties up cash or causes stock-outs, so I would require human approval for EOQ-exception orders such as SKU-007's 1,018 units.

## Demo video

_Link to be added._
