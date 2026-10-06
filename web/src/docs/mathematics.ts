import type { DocBlock, DocPage, DocSection } from "./content";
const p = (text: string): DocBlock => ({ type: "paragraph", text });
const eq = (title: string, latex: string, caption: string): DocBlock => ({
  type: "equation",
  title,
  latex,
  caption,
});
const note = (title: string, text: string): DocBlock => ({
  type: "note",
  title,
  text,
});
const list = (...items: string[]): DocBlock => ({ type: "list", items });
const table = (columns: string[], rows: string[][]): DocBlock => ({
  type: "table",
  columns,
  rows,
});
const s = (id: string, title: string, ...blocks: DocBlock[]): DocSection => ({
  id,
  title,
  blocks,
});
export const mathPages: DocPage[] = [
  {
    slug: "mathematical-framework",
    title: "An economy as a state system",
    description:
      "A theoretical language for connecting price discovery, capital allocation, holder rights, and fee distributions.",
    sections: [
      s(
        "scope-and-notation",
        "Scope and notation",
        p(
          "A token economy is more than a price curve. Its behavior depends on how trading changes balances, how graduation assigns capital, and when participants can exercise a right. A useful mathematical description combines continuous quantities with discrete lifecycle states.",
        ),
        note(
          "Public theory",
          "This chapter presents general economic relationships and illustrative models. It is not a specification of DepthGuard's production algorithms, calibration process, transaction construction, or deployment settings.",
        ),
        eq(
          "State representation",
          String.raw`z_t = (q_t, x_t, y_t, R_t, B_t, F_t, \sigma_t)`,
          "q is an allocation coordinate; x and y represent market reserves; R is a redemption reserve; B is remaining project capital; F is eligible fee value; and σ is the lifecycle state. The notation is an analytical abstraction, not an application data format.",
        ),
      ),
      s(
        "state-transitions",
        "State transitions",
        p(
          "Let an action u describe a purchase, sale, graduation, milestone decision, or redemption. A model with terms θ permits a transition only when the action is valid in the current state. This distinction separates a requested action from an available economic right.",
        ),
        eq(
          "Admissible transition",
          String.raw`z_{t+1}=\Phi_{\theta}(z_t,u_t),\qquad (z_t,u_t)\in\mathcal{A}_{\theta}`,
          "Φ denotes the model's abstract transition rule. The admissible set A captures balance constraints, supported actions, lifecycle conditions, and participant eligibility.",
        ),
        p(
          "A rejected action is meaningful evidence. An unfunded reserve, an insufficient balance, or a participant without the required role can place an action outside the admissible set even when a displayed hypothetical calculation looks favorable.",
        ),
      ),
      s(
        "local-and-global-properties",
        "Local and global properties",
        p(
          "Local properties describe one trade or one transition. Global properties describe what remains true across a sequence of permitted actions. Positive reserves, a consistent capital partition, and claims bounded by eligible funding are examples of properties worth checking across a path.",
        ),
        eq(
          "Pathwise admissibility",
          String.raw`z_0\in\mathcal{Z}_{\theta},\quad z_{t+1}=\Phi_{\theta}(z_t,u_t)\in\mathcal{Z}_{\theta}\quad\forall t`,
          "An admissible initial state and permitted actions should keep the economy within its defined state constraints. A single successful observation is not a proof for every possible path.",
        ),
      ),
      s(
        "the-design-question",
        "The design question",
        p(
          "Economic design is a constrained choice among tradeoffs. Initial distribution, secondary-market depth, separate holder rights, and recipient fees can compete for the same finite capital. A model is useful when its tradeoffs match a clearly stated purpose.",
        ),
        list(
          "Use [Price discovery](/docs/price-discovery) to reason about order size and curve shape.",
          "Use [Capital conservation](/docs/capital-conservation) to compare allocations coherently.",
          "Use [Scenario analysis](/docs/scenario-analysis) to distinguish a theoretical condition from tested evidence.",
        ),
      ),
    ],
  },
  {
    slug: "price-discovery",
    title: "Price discovery & liquidity",
    description:
      "Connect marginal price, cumulative trade cost, curvature, and the execution depth of a destination market.",
    sections: [
      s(
        "marginal-price",
        "Marginal price and cumulative cost",
        p(
          "Consider a stylized launch with a non-negative marginal price p(q), where q measures allocation along the launch path. A purchase spanning an interval pays for the entire interval, not only the displayed price at its beginning. Ignore fees in this first relationship.",
        ),
        eq(
          "Cost over an allocation interval",
          String.raw`C(q,\Delta q)=\int_q^{q+\Delta q}p(u)\,du,\qquad \bar p=\frac{C(q,\Delta q)}{\Delta q}`,
          "C is the net quote amount associated with a purchase of Δq token units. The average execution price differs from the marginal price whenever p varies over the order interval.",
        ),
        eq(
          "Local approximation",
          String.raw`C(q,\Delta q)=p(q)\Delta q+\frac{p'(q)}{2}(\Delta q)^2+O((\Delta q)^3)`,
          "For a sufficiently smooth price function and a small interval, the first curvature term explains why larger orders can diverge from a spot-price estimate. This is a local approximation, not a large-order guarantee.",
        ),
      ),
      s(
        "curve-families",
        "Illustrative curve families",
        p(
          "Flat, linear, and convex shapes can express different initial distribution preferences. The illustration below uses normalized coordinates and generic curves. It does not compute a launchable DepthGuard configuration.",
        ),
        { type: "diagram", kind: "price-curves" },
        eq(
          "Two theoretical examples",
          String.raw`p_{\mathrm{linear}}(q)=p_0+\alpha q,\qquad p_{\mathrm{convex}}(q)=p_0 e^{\beta q}`,
          "p₀ is a positive starting price. Non-negative α or β create increasing examples. These are conceptual functions, not a claim that arbitrary formulas are directly executable by DBC.",
        ),
        p(
          "A curve with a smaller slope can reduce marginal-price variation over a specific range. That property says nothing by itself about the capital available after graduation.",
        ),
      ),
      s(
        "destination-depth",
        "A secondary-market benchmark",
        p(
          "For intuition, consider an ideal constant-product market with base reserve x and quote reserve y. Ignore fees, transfers, and range restrictions. A sale of Δx base units produces the following benchmark output.",
        ),
        eq(
          "Constant-product sale benchmark",
          String.raw`xy=k,\qquad Q_{\mathrm{out}}=\frac{y\Delta x}{x+\Delta x}`,
          "This idealized relationship describes a fully available constant-product reserve pair. Actual execution must be obtained from the supported market quote; configuration and fee treatment can change the result.",
        ),
        eq(
          "Relative execution shortfall",
          String.raw`p_{\mathrm{spot}}=\frac{y}{x},\qquad 1-\frac{Q_{\mathrm{out}}}{p_{\mathrm{spot}}\Delta x}=\frac{\Delta x}{x+\Delta x}`,
          "A larger order relative to available base reserves has a larger fee-free shortfall from the initial spot-price estimate. Price equality does not establish depth equality.",
        ),
      ),
      s(
        "transition-comparisons",
        "Compare the transition at an order size",
        eq(
          "An order-specific comparison",
          String.raw`\varepsilon(\Delta)=1-\frac{O_{\mathrm{after}}(\Delta)}{O_{\mathrm{before}}(\Delta)}`,
          "O denotes comparable net sell outputs for the same token amount, with an explicitly stated fee basis. A positive ε means the after-transition output is lower; a negative value means it is higher.",
        ),
        p(
          "Compare several order sizes and the same capital basis. Matching a marginal price at the transition does not imply equal output for finite orders, and a result near zero for one order size does not establish continuity at every size.",
        ),
      ),
    ],
  },
  {
    slug: "capital-conservation",
    title: "Capital conservation",
    description:
      "Make allocations comparable by treating liquidity, project funding, reserves, and costs as distinct uses of finite capital.",
    sections: [
      s(
        "a-capital-partition",
        "A capital partition",
        p(
          "Use one asset denomination and one observation time when comparing capital. Let K be the available capital at the relevant allocation point. Destination liquidity L, project budget B, reserve R, explicit costs C, and retained remainder U must fit within that amount.",
        ),
        eq(
          "Capital partition",
          String.raw`K=L+B+R+C+U,\qquad L,B,R,C,U\geq 0`,
          "Each term represents a distinct use of the same capital at the stated point. Capital from a separate, later deposit should be recorded separately rather than silently included in K.",
        ),
        p(
          "This partition prevents a common comparison error: counting a funded reserve as backing while also describing those same assets as freely available trading liquidity.",
        ),
      ),
      s(
        "the-feasible-set",
        "The feasible set",
        eq(
          "Allocation feasibility",
          String.raw`\ell+b+r+c\leq 1,\qquad \ell,b,r,c\geq 0`,
          "Lower-case terms are fractions of available capital. The unused fraction is the retained remainder. Any stricter model-specific requirement still applies.",
        ),
        p(
          "Under fixed capital and costs, increasing a project or reserve allocation reduces what remains for the other uses. A rights-based model can offer a valuable entitlement while having a smaller destination trading budget than a pure community model.",
        ),
      ),
      s(
        "depth-and-capital",
        "Depth and capital scaling",
        p(
          "In the ideal constant-product benchmark, increasing both reserves by a positive factor λ preserves the spot price. It changes the relative size of a fixed order, which changes its execution depth. Ignore fees for this comparison.",
        ),
        eq(
          "Same price, different depth",
          String.raw`x'=\lambda x,\quad y'=\lambda y,\quad \frac{y'}{x'}=\frac{y}{x}`,
          "A shared reserve ratio preserves the benchmark spot price. It does not make the markets equally deep.",
        ),
        eq(
          "Scaled-market output",
          String.raw`Q'_{\mathrm{out}}=\frac{\lambda y\Delta x}{\lambda x+\Delta x}`,
          "For the same base order, more available reserves improve the fee-free constant-product execution benchmark. A curve change alone does not provide this extra capital.",
        ),
      ),
      s(
        "compare-models-fairly",
        "Compare models fairly",
        list(
          "Use the same initial capital basis and quote denomination.",
          "Separate initial allocations from subsequent deposits.",
          "Compare actual available market reserves rather than a nominal total-raised figure.",
          "Value a funded right separately from a trading-output metric.",
          "Keep protocol costs and retained balances explicit.",
        ),
        p(
          "A model comparison should report what each design provides in return for the capital it uses. More favorable early distribution and a larger redemption reserve are different benefits; neither should be described as cost-free liquidity.",
        ),
      ),
    ],
  },
  {
    slug: "redemption-math",
    title: "Redemption & outstanding supply",
    description:
      "Examine proportional reserve claims, conservative rounding, and the effect of a burn on the remaining reserve ratio.",
    sections: [
      s(
        "the-reference-model",
        "The reference model",
        p(
          "Consider an active proportional reserve with R quote-asset atomic units and S outstanding base-token atomic units. A holder burns b base units, where b is positive and does not exceed S or the holder's eligible balance. This reference relationship ignores any separately specified redemption fee.",
        ),
        eq(
          "Proportional payout",
          String.raw`P=\left\lfloor\frac{bR}{S}\right\rfloor,\qquad 0<b\leq S`,
          "The payout is rounded down in quote-asset atomic units. R and S are measured immediately before the eligible redemption. Use the actual model's quoted payout for an execution decision.",
        ),
        p(
          "Outstanding supply includes unburned tokens beyond a particular holder's wallet. Treating only one account's balance as S would overstate that holder's share of the reserve.",
        ),
      ),
      s(
        "the-post-redemption-state",
        "The post-redemption state",
        eq(
          "Reserve and supply after redemption",
          String.raw`R'=R-P,\qquad S'=S-b`,
          "The paid reserve decreases by P while supply decreases by the burned amount b. This describes the same eligible event, rather than an independent transfer and a separate hypothetical burn.",
        ),
        p(
          "For a partial redemption with b less than S, write the exact unrounded payout as bR/S and its downward-rounding remainder as δ. The remaining reserve ratio can then be expressed directly.",
        ),
        eq(
          "Rounding remainder",
          String.raw`\delta=\frac{bR}{S}-P,\qquad 0\leq\delta<1`,
          "δ is less than one quote-asset atomic unit for the integer-floor reference model.",
        ),
        eq(
          "Remaining reserve ratio",
          String.raw`\frac{R'}{S'}=\frac{R}{S}+\frac{\delta}{S-b}\qquad (b<S)`,
          "Without another concurrent change, conservative rounding cannot reduce the remaining reserve per outstanding token in this reference model. This is not a statement about the token's trading price.",
        ),
      ),
      s(
        "final-redemption-and-small-amounts",
        "Final redemption and small amounts",
        p(
          "When b equals S in this fee-free integer model, P equals R. The remaining supply is zero, so a reserve-per-token ratio is no longer defined. For small b, rounding can produce a zero payout even though the unrounded proportion is positive.",
        ),
        note(
          "Quote before approval",
          "Eligibility, active state, actual balances, fees, and a minimum payout bound still matter. A theoretical non-negative amount does not mean the current application accepts a zero-payout redemption.",
        ),
      ),
      s(
        "redemption-versus-price",
        "Redemption is not market price",
        p(
          "Reserve coverage is a claim on the funded reserve under the model's terms. Market price is an execution outcome in a separate market. Their values can differ because of fees, activation, liquidity, trading behavior, and the reserve asset's own external value.",
        ),
        p(
          "For funding refunds, the analogous reserve is the remaining eligible project capital. Previously released funds should not be included in R unless they have actually returned to the refund budget.",
        ),
      ),
    ],
  },
  {
    slug: "fee-mathematics",
    title: "Fee flows & distributions",
    description:
      "Distinguish gross trading costs, eligible claims, recipient allocations, and value retained in liquidity.",
    sections: [
      s(
        "gross-and-eligible-fees",
        "Gross and eligible fees",
        p(
          "Let G be observed gross trading fees over a clearly defined period. Protocol deductions, fees retained or reinvested in liquidity, and other applicable deductions determine how much can enter an eligible distribution stream. These categories must be defined without overlap.",
        ),
        eq(
          "An accounting decomposition",
          String.raw`G=D+H+E`,
          "D represents applicable deductions, H represents fees retained for the separately identified liquidity treatment, and E is the eligible stream for the stated policy. This is a conceptual accounting partition, not a universal protocol fee formula.",
        ),
      ),
      s(
        "recipient-policy",
        "Recipient policy",
        p(
          "For a funded eligible amount E and n recipient weights wᵢ, a proportional policy assigns each recipient a share. Weights must be non-negative and sum to one. If payout units are indivisible, individual claims require a stated rounding treatment.",
        ),
        eq(
          "Weights and proportional amounts",
          String.raw`w_i\geq 0,\quad\sum_{i=1}^{n}w_i=1,\qquad A_i=\lfloor w_iE\rfloor`,
          "The floor relationship illustrates a single distribution of a fixed integer amount. Actual cumulative claim accounting can use a different supported method and must be read from the live fee state.",
        ),
        eq(
          "Conservative distribution bound",
          String.raw`\sum_{i=1}^{n}A_i\leq E,\qquad 0\leq E-\sum_iA_i<n`,
          "For the single-distribution integer-floor example, recipient amounts cannot exceed eligible funding and the residual is less than n atomic units. This example does not prescribe a cumulative implementation.",
        ),
      ),
      s(
        "compounding-and-claims",
        "Compounding and claims",
        p(
          "Under an illustrative policy, let F be fee value after the deductions relevant to that policy and let γ be the share retained for compounding. Value retained for liquidity and value available for cash claims are different uses of F.",
        ),
        eq(
          "A compounding partition",
          String.raw`F_{\mathrm{retained}}=\gamma F,\quad F_{\mathrm{claimable}}=(1-\gamma)F,\quad 0\leq\gamma\leq 1`,
          "This describes a generic economic partition. The actual protocol, collection mode, and model determine which settings are available and how the fee value is realized.",
        ),
        p(
          "A higher retained fraction can leave less fee value available to recipients over the same period. Reinvested fees do not create a second, simultaneous cash payout for the same value.",
        ),
      ),
      s(
        "claim-accounting",
        "Claim accounting",
        eq(
          "Funding bounds claims",
          String.raw`\text{paid claims}+\text{unpaid eligible claims}\leq\text{eligible funds received}`,
          "Read this as a conservation requirement over a consistent accounting scope. Trading volume, estimated future fees, project capital, and reserves are not substitutes for funds actually received into that scope.",
        ),
        p(
          "Distinguish accrued estimates, funded distribution amounts, and completed payouts when reading Earnings. They describe different stages of the fee lifecycle.",
        ),
      ),
    ],
  },
  {
    slug: "scenario-analysis",
    title: "Scenario analysis & sensitivity",
    description:
      "Study a model across paths and parameter changes without turning an experiment into an unsupported universal claim.",
    sections: [
      s(
        "paths-and-outcomes",
        "Paths and outcomes",
        p(
          "Let θ describe a model and ω describe an ordered scenario: actions, initial conditions, and any explicitly modeled external assumptions. An outcome metric M(θ, ω) might measure net sell output, destination capital, or a supported rights payout.",
        ),
        eq(
          "A comparison under the same scenario",
          String.raw`\Delta M(\omega)=M(\theta_1,\omega)-M(\theta_0,\omega)`,
          "Compare the candidate θ₁ with a stated baseline θ₀ under the same scenario. Keep units, fee basis, and starting capital consistent.",
        ),
        p(
          "If the scenario changes at the same time as the model, the result combines both effects. That can be a useful separate experiment, but it should not be presented as a controlled model comparison.",
        ),
      ),
      s(
        "local-sensitivity",
        "Local sensitivity",
        eq(
          "Finite-difference sensitivity",
          String.raw`\frac{\partial M}{\partial\theta_j}\approx\frac{M(\theta+h e_j,\omega)-M(\theta-h e_j,\omega)}{2h}`,
          "This centered approximation requires meaningful, feasible perturbations and a suitably smooth local metric. It is not appropriate across an unavailable configuration or a discontinuous activation boundary.",
        ),
        p(
          "The step size matters. A step that is too large mixes distant behavior; one that is too small can be dominated by integer rounding or numerical precision. Inspect the neighboring cases, not only the derivative estimate.",
        ),
      ),
      s(
        "robustness-over-a-set",
        "Robustness over a scenario set",
        eq(
          "A bounded worst-case comparison",
          String.raw`M_{\min}(\theta;\Omega)=\min_{\omega\in\Omega}M(\theta,\omega)`,
          "Ω is an explicitly chosen finite scenario set. Its minimum is a worst case within that set, not a proof over all future trading or external conditions.",
        ),
        list(
          "Include both favorable and challenging paths.",
          "Include boundary conditions and rejected actions where relevant.",
          "Record which cases are valid for each model.",
          "Separate observed execution from analytical estimates.",
        ),
      ),
      s(
        "multiple-objectives",
        "Multiple objectives",
        p(
          "Models can optimize different objectives: distribution, execution depth, capital rights, or recipient fee availability. No single score should silently erase those tradeoffs. A Pareto comparison asks whether an improvement in one metric requires a deterioration in another.",
        ),
        eq(
          "Dominance for maximized metrics",
          String.raw`\theta_1\succ\theta_0\iff\bigl(\forall j:\ M_j(\theta_1)\geq M_j(\theta_0)\bigr)\ \land\ \bigl(\exists j:\ M_j(\theta_1)>M_j(\theta_0)\bigr)`,
          "Each metric needs a declared direction and comparable assumptions. For a metric such as cost that should be minimized, transform or reverse the comparison explicitly.",
        ),
        p(
          "A finite study can identify a candidate worth further research. It cannot establish demand, every future path, or general superiority over another platform. The defensible conclusion remains tied to its evidence and tested range.",
        ),
      ),
    ],
  },
];
