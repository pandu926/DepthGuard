import { mathPages } from "./mathematics";
export type DocBlock =
  | { type: "paragraph"; text: string }
  | { type: "equation"; title: string; latex: string; caption: string }
  | { type: "diagram"; kind: "price-curves" | "lifecycle" }
  | { type: "list"; items: string[] }
  | { type: "steps"; items: string[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "note"; title: string; text: string }
  | { type: "faq"; items: { question: string; answer: string }[] };
export type DocSection = { id: string; title: string; blocks: DocBlock[] };
export type DocPage = {
  slug: string;
  title: string;
  description: string;
  sections: DocSection[];
};
export const docGroups = [
  {
    title: "Start here",
    pages: ["introduction", "quickstart", "wallet-and-network"],
  },
  {
    title: "Create an economy",
    pages: [
      "create-a-token",
      "economy-studio",
      "parameters",
      "publish-and-launch",
    ],
  },
  {
    title: "Launch models",
    pages: [
      "community-launch",
      "milestone-funding",
      "reserve-economy",
      "asset-markets",
    ],
  },
  {
    title: "Research & simulation",
    pages: ["simulations", "stress-testing", "reading-results"],
  },
  {
    title: "Mathematical perspective",
    pages: [
      "mathematical-framework",
      "price-discovery",
      "capital-conservation",
      "redemption-math",
      "fee-mathematics",
      "scenario-analysis",
    ],
  },
  {
    title: "Trading & holder rights",
    pages: ["swaps", "graduation", "holder-rights"],
  },
  {
    title: "Models & earnings",
    pages: ["reuse-models", "model-authors", "fees-and-earnings"],
  },
  {
    title: "Reference",
    pages: ["transactions", "security", "release-status", "glossary", "faq"],
  },
];
const p = (text: string): DocBlock => ({ type: "paragraph", text });
const list = (...items: string[]): DocBlock => ({ type: "list", items });
const steps = (...items: string[]): DocBlock => ({ type: "steps", items });
const note = (title: string, text: string): DocBlock => ({
  type: "note",
  title,
  text,
});
const table = (columns: string[], rows: string[][]): DocBlock => ({
  type: "table",
  columns,
  rows,
});
const section = (
  id: string,
  title: string,
  ...blocks: DocBlock[]
): DocSection => ({ id, title, blocks });
export const docPages: DocPage[] = [
  {
    slug: "introduction",
    title: "Economies by design.",
    description:
      "A practical guide to designing, researching, launching, and sharing token economies on DepthGuard.",
    sections: [
      section(
        "what-is-depthguard",
        "What is DepthGuard?",
        p(
          "DepthGuard is a token economy platform on Solana. Creators choose or design a reusable economic model, examine its behavior, and use it to launch a token. Buyers can inspect the market, trading costs, and any supported holder rights before participating.",
        ),
        p(
          "The model is the starting point. It brings together pricing, distribution, fees, graduation, and supported capital rules in one inspectable version. A familiar community launch, a milestone funding model, and a reserve economy can share the same creation experience while offering different rights.",
        ),
      ),
      section(
        "one-connected-lifecycle",
        "One connected lifecycle",
        table(
          ["Stage", "What happens"],
          [
            [
              "Design",
              "Choose a model and configure the choices available to that model.",
            ],
            [
              "Research",
              "Validate the draft and examine trading, graduation, and supported rights scenarios.",
            ],
            [
              "Launch",
              "Review the published terms, approve the required wallet actions, and establish a new market.",
            ],
            [
              "Discover",
              "Trade through Meteora Dynamic Bonding Curve during initial price discovery.",
            ],
            [
              "Graduate",
              "Move into a Meteora DAMM v2 market when the launch conditions are met and the transition completes.",
            ],
            [
              "Participate",
              "Trade, exercise active holder rights, and claim eligible fees.",
            ],
          ],
        ),
        p(
          "Meteora supplies the launch and destination markets. DepthGuard connects them to reusable models, creator workflows, research, and supported funding or reserve experiences. Each launch has its own token, market state, and funds.",
        ),
      ),
      section(
        "choose-your-path",
        "Choose your path",
        list(
          "**Creators:** start with [Create a token](/docs/create-a-token), then review the relevant launch model.",
          "**Traders and holders:** read [Swaps](/docs/swaps) and [Holder rights](/docs/holder-rights) before participating.",
          "**Model authors:** learn how [Model authors](/docs/model-authors) publish versions and share in eligible trading fees.",
          "**Researchers:** begin with [Simulation Lab](/docs/simulations) and learn how to interpret evidence.",
        ),
      ),
      section(
        "current-release",
        "About this release",
        note(
          "Development preview",
          "The current release is a Solana devnet preview. Devnet activity demonstrates product behavior with test assets; it does not represent a production market or an independent security audit.",
        ),
        p(
          "Community, milestone funding, and reserve workflows have completed devnet lifecycle acceptance. Asset-quoted markets remain a research experience with additional compatibility requirements. [Release status](/docs/release-status) describes the available scope.",
        ),
      ),
    ],
  },
  {
    slug: "quickstart",
    title: "Your first session",
    description:
      "Move from an idea to a reviewed launch without starting from a blank configuration.",
    sections: [
      section(
        "before-you-begin",
        "Before you begin",
        p(
          "You can browse models and use the public research tools before connecting a wallet. Saving account-based work, publishing, trading, and submitting transactions require a compatible Solana wallet and, where requested, a signed authentication message.",
        ),
        list(
          "Open DepthGuard through its HTTPS domain.",
          "Use a wallet that supports Solana transaction and message signing.",
          "Check the network shown in the application. The current release uses devnet.",
          "Keep enough test SOL for network fees, account creation, and any intended test purchases.",
        ),
      ),
      section(
        "create-your-first-launch",
        "Create your first launch",
        steps(
          "Open [Create token](/create/identity). Enter the token name, symbol, and metadata URI.",
          "Select a community launch for a straightforward first experiment. Use funding or reserve models only after reviewing their rights and capital requirements.",
          "Review the model parameters. Keep a coherent starting model rather than changing several dependent settings at once.",
          "Open the preview. Examine the price discovery path, graduation target, capital allocation, and any capability restrictions.",
          "Review the final token identity, model version, fee recipients, and supported rights.",
          "Approve the wallet actions presented by the launch workflow. Follow its progress until the market becomes available.",
        ),
        p(
          "A launch can require several approvals. Closing a browser window is not evidence that an already submitted transaction failed. Return to the launch workspace and check its recorded status before starting another launch.",
        ),
      ),
      section(
        "try-a-trade",
        "Try a trade",
        p(
          "Open the token page, confirm the active market, and request a small buy quote. Review the amount, output bound, and trading fee before approving. After completion, inspect Activity and the resulting token balance.",
        ),
        p(
          "A useful first session also includes a small sell and a look at how the quote changes. A trade is an execution test, not evidence that the economy will attract demand or maintain a particular price.",
        ),
      ),
      section(
        "continue-learning",
        "Continue learning",
        list(
          "Use [Economy Studio](/docs/economy-studio) to explore a model deliberately.",
          "Use [Stress testing](/docs/stress-testing) to examine large exits and alternative trading paths.",
          "Read [Transactions](/docs/transactions) if progress pauses or an approval expires.",
        ),
      ),
    ],
  },
  {
    slug: "wallet-and-network",
    title: "Wallet & network",
    description:
      "Understand browsing, authentication, transaction approval, and the network used by the current release.",
    sections: [
      section(
        "connect-and-authenticate",
        "Connect and authenticate",
        p(
          "Connecting a wallet makes its selected public account available to the application. Authentication is a separate action: you sign an expiring message that identifies DepthGuard, the account, and the network. This creates an application session without sending a token transaction.",
        ),
        p(
          "Check the message origin before signing. DepthGuard does not ask you to enter a recovery phrase or private key. Switching accounts can require a new authentication session for the selected account.",
        ),
      ),
      section(
        "approve-transactions",
        "Approve transactions",
        p(
          "A transaction approval authorizes a specific on-chain action. Review the operation and the requesting website in your wallet. A trading approval differs from a login message: it can move assets and incur network fees.",
        ),
        list(
          "Read each approval as part of the current workflow.",
          "Check the intended token and amount before a swap or redemption.",
          "Use Activity to distinguish a prepared action from a finalized transaction.",
          "Reject an unexpected prompt and return to the relevant application page to investigate.",
        ),
      ),
      section(
        "network-and-test-assets",
        "Network and test assets",
        p(
          "The application displays its active network. The present deployment is on Solana devnet, where SOL and tokens are test assets. A wallet's mainnet balance cannot pay for a devnet action, and a devnet result does not create a mainnet balance.",
        ),
        note(
          "Keep networks consistent",
          "Use a wallet account and assets on the network displayed by DepthGuard. If an operation is unavailable, check network selection and capability status before changing the model.",
        ),
      ),
      section(
        "browser-and-session",
        "Browser and session requirements",
        p(
          "Use the HTTPS domain for wallet signing. Wallet availability depends on the installed provider and its supported signing features. You can browse without a compatible wallet, but authenticated or transactional actions remain unavailable.",
        ),
        p(
          "Signing out ends the application session. It does not reverse finalized blockchain activity. If the wallet is disconnected during a workflow, reconnect the same account and check progress before resubmitting an action.",
        ),
      ),
    ],
  },
  {
    slug: "create-a-token",
    title: "Create a token",
    description:
      "Give a new token an identity, select its economy, and review its lifecycle before requesting a launch.",
    sections: [
      section(
        "token-identity",
        "Token identity",
        p(
          "The creation flow begins with a name, symbol, and metadata URI. The current identity form accepts a name of up to 32 characters, a symbol of up to 10 characters, and an HTTPS or IPFS metadata URI. Review spelling and the metadata destination before continuing.",
        ),
        p(
          "A familiar name or symbol does not establish ownership, affiliation, or backing. Buyers should distinguish a token's public identity from the economic rights attached to its actual launch.",
        ),
      ),
      section(
        "select-an-economy",
        "Select an economy",
        p(
          "Choose a model that matches the intended purpose. A community launch prioritizes price discovery and a destination market. Funding adds a defined project budget and milestone review. A reserve economy adds an active, funded redemption right.",
        ),
        table(
          ["Purpose", "Start with", "Read first"],
          [
            [
              "Community or meme token",
              "Community launch",
              "Trading costs and graduation",
            ],
            [
              "Project capital released in stages",
              "Milestone funding",
              "Reviewer rules, deadlines, and refund conditions",
            ],
            [
              "A funded holder exit right",
              "Reserve economy",
              "Reserve activation and redemption",
            ],
            [
              "Alternative quote asset research",
              "Asset markets",
              "Mint compatibility and availability",
            ],
          ],
        ),
      ),
      section(
        "review-parameters",
        "Review parameters and preview",
        p(
          "The parameters step configures choices permitted by the selected model. Pricing, supply, allocations, and graduation are related; a valid field value on its own does not guarantee a valid overall economy.",
        ),
        p(
          "Use the preview to review the combined result. Check which capital goes to the destination market, whether a separate capital allocation is required, and when any holder right becomes active. Return to the editor when a restriction or invalid combination is reported.",
        ),
      ),
      section(
        "review-and-create",
        "Review and create",
        list(
          "Confirm token identity and quote units.",
          "Confirm the model version, author attribution, and fee policy.",
          "Check allocations, recipients, and the obligations attached to the model.",
          "Review which actions require wallet approval and follow the launch workspace.",
        ),
        p(
          "A model version is separate from a token launch. Using a model creates a new instance; it does not reuse another launch's balances, holders, or reserves. See [Publish and launch](/docs/publish-and-launch) for the distinction.",
        ),
      ),
    ],
  },
  {
    slug: "economy-studio",
    title: "Economy Studio",
    description:
      "Turn an economic idea into a reviewed model through a deliberate edit, research, and publication workflow.",
    sections: [
      section(
        "start-with-a-purpose",
        "Start with a purpose",
        p(
          "Define the behavior you want before adjusting a curve. Decide who should participate, how trading should begin, where capital should go at graduation, and whether holders need a funded right beyond market trading.",
        ),
        p(
          "Open [Economy Studio](/studio) and choose a suitable starting model. A draft is a workspace for experimentation. Its settings do not alter an existing live launch.",
        ),
      ),
      section(
        "edit-with-context",
        "Edit with context",
        p(
          "Basic controls focus on the choices needed to understand a model. Advanced controls are for users who want to examine more detailed native settings. Both views remain subject to the supported model's constraints.",
        ),
        list(
          "Work in clearly identified token and quote units.",
          "Treat derived values as consequences of the selected configuration.",
          "Read capability restrictions before planning a launch.",
          "Change one group of related settings at a time and compare the result.",
        ),
      ),
      section(
        "research-before-publication",
        "Research before publication",
        p(
          "A reasonable workflow is to validate the draft, inspect graduation, test a small trade sequence, and examine a larger sell. Funding and reserve models should also be tested against their relevant release or redemption scenarios.",
        ),
        p(
          "Keep the question behind each experiment explicit. A curve that distributes tokens differently may still reach a similar destination market. A larger allocation to project capital or reserves can leave less capital available for trading liquidity.",
        ),
      ),
      section(
        "save-and-share",
        "Save and share",
        p(
          "Drafts can support repeated work before publication. A published version identifies the model used by later launches. If the economic rules change, treat the change as a new version or a fork rather than describing an old version as updated.",
        ),
        note(
          "Publication is not endorsement",
          "A published or successfully simulated model has inspectable terms. Publication does not establish profitability, independent audit status, or market demand.",
        ),
        p(
          "Continue with [Model authors](/docs/model-authors) for publication and adoption, or [Parameter guide](/docs/parameters) for the available categories of control.",
        ),
      ),
    ],
  },
  {
    slug: "parameters",
    title: "Parameter guide",
    description:
      "Understand the categories of choices that shape a model, and the dependencies that should guide an edit.",
    sections: [
      section(
        "pricing-and-supply",
        "Pricing and supply",
        table(
          ["Category", "Purpose", "Consideration"],
          [
            [
              "Supply and decimals",
              "Define token quantity and display precision.",
              "Precision changes how human amounts map to token units.",
            ],
            [
              "Starting conditions",
              "Set the beginning of price discovery.",
              "Read together with supply and the curve.",
            ],
            [
              "Curve shape",
              "Determine how pricing and distribution evolve during the launch.",
              "A custom shape is bounded by supported native behavior.",
            ],
            [
              "Graduation target",
              "Set a launch condition for the destination market.",
              "Changing a target can require reviewing the surrounding configuration.",
            ],
          ],
        ),
        p(
          "A flatter initial path can distribute tokens differently from a steeper path. Neither shape creates extra capital. The terminal launch price and the behavior of the secondary market are separate considerations.",
        ),
      ),
      section(
        "capital-and-rights",
        "Capital and rights",
        p(
          "Capital choices define the use of available funds. Depending on the model, funds may support destination liquidity, a project budget, or a reserve. An allocation to one purpose is not simultaneously available for another.",
        ),
        list(
          "**Trading liquidity:** capital available to support the destination market.",
          "**Project funding:** a separate budget subject to its defined release rules.",
          "**Reserve:** funded assets available under an active redemption right.",
          "**Distribution and locks:** who receives tokens or liquidity interests, and the restrictions that apply.",
        ),
      ),
      section(
        "fees-and-availability",
        "Fees and availability",
        p(
          "Fee settings can affect trading costs, the portion of fees eligible for claims, and the policy for distributing those claims. Always separate trade volume, trading fees, and the actual claimable fee stream.",
        ),
        p(
          "Some settings are available for research without being supported by the current launch workflow. A visible research field is not permission to deploy that configuration. The application must accept the complete model and its required capabilities before launch.",
        ),
      ),
      section(
        "responsible-iteration",
        "A useful editing sequence",
        steps(
          "Choose a purpose and starting model.",
          "Review units, supply, pricing, and graduation together.",
          "Review capital allocations and supported holder rights.",
          "Review fee policy and recipient roles.",
          "Validate, simulate, and compare against the unchanged starting model.",
        ),
        p(
          "Use the application for current field-level limits and available controls. These public guides explain the economic meaning of the choices; they do not prescribe a universally optimal configuration.",
        ),
      ),
    ],
  },
  {
    slug: "publish-and-launch",
    title: "Publish and launch",
    description:
      "Understand the difference between registering economic rules and creating an instance that uses them.",
    sections: [
      section(
        "two-distinct-actions",
        "Two distinct actions",
        table(
          ["Action", "Result", "Does not create"],
          [
            [
              "Publish a model",
              "An identified version with author attribution and a fee policy.",
              "A new token market or funded reserve.",
            ],
            [
              "Launch a token",
              "A new instance using an accepted model version.",
              "Another launch's holders, balances, or historical performance.",
            ],
          ],
        ),
        p(
          "A creator can publish a reusable model without launching a token from it. A launcher can select an existing model without claiming to be its original author.",
        ),
      ),
      section(
        "version-discipline",
        "Version discipline",
        p(
          "Review the published version before reusing it. A name alone is not enough to identify economic terms. The model's version, registered author, mechanism, and fee policy establish the reference for the launch experience.",
        ),
        p(
          "Changing economic settings requires a new publication or a fork. A change to a draft does not rewrite the terms of an already published version or change a live pool.",
        ),
      ),
      section(
        "launch-approvals",
        "Launch approvals and progress",
        p(
          "A launch is a sequence of actions that establishes a token and its required market or rights components. The workspace presents the next action and records submitted progress. Approve only the actions associated with the intended launch.",
        ),
        list(
          "Check the connected launcher account.",
          "Keep the published model reference and token metadata consistent.",
          "Complete the required approvals and funding.",
          "Wait for the recorded completion state before treating the launch as available.",
        ),
      ),
      section(
        "when-progress-stops",
        "When progress stops",
        p(
          "If a wallet prompt is rejected, return to the workflow and review the pending action. If a transaction was already submitted, inspect its status before attempting another submission. A slow page or RPC delay does not by itself establish failure.",
        ),
        p(
          "An unavailable capability or rejected configuration requires a model review. An expired transaction can require a fresh approval. [Transaction lifecycle](/docs/transactions) explains these cases.",
        ),
      ),
    ],
  },
  {
    slug: "community-launch",
    title: "Community launches",
    description:
      "A familiar token launch with configurable initial price discovery and a destination market after graduation.",
    sections: [
      section(
        "model-purpose",
        "Model purpose",
        p(
          "The community model is the simplest starting point for a meme, community, or experimental token. Trading begins on Meteora DBC. When the launch condition is met and migration completes, trading continues through a DAMM v2 market.",
        ),
        p(
          "The economic design can shape the initial distribution and price path. The model still depends on actual participation, available capital, and secondary-market activity.",
        ),
      ),
      section(
        "creator-decisions",
        "Creator decisions",
        list(
          "Select a coherent pricing and supply configuration.",
          "Choose a graduation target appropriate to the intended experiment.",
          "Review liquidity treatment and the fee policy.",
          "Explain the purpose of the token without implying rights that the model does not provide.",
        ),
        p(
          "A community launch gives access to a token market. It does not automatically provide a reserve claim, ownership in a company, project refunds, or distributions from an external business.",
        ),
      ),
      section(
        "what-buyers-should-review",
        "What buyers should review",
        p(
          "Inspect the token identity, the selected model, the current market stage, and the quote presented for the intended order. Graduation progress is one part of the lifecycle, not a measure of investment quality.",
        ),
        note(
          "Liquidity locks have a specific scope",
          "A lock restricts the affected liquidity position. It does not stop holders from selling, eliminate price impact, or protect a token's market price.",
        ),
      ),
      section(
        "graduation-and-beyond",
        "Graduation and beyond",
        p(
          "The destination market has its own reserves and trading behavior. A relatively flat launch path does not make the later market flat. Compare trading quotes at meaningful order sizes rather than assuming that a displayed price remains available for every trade.",
        ),
        p(
          "Read [Graduation](/docs/graduation) for the transition and [Swaps](/docs/swaps) for execution behavior.",
        ),
      ),
    ],
  },
  {
    slug: "milestone-funding",
    title: "Milestone funding",
    description:
      "Structure a project budget around defined milestones, reviewers, and remaining-capital rights.",
    sections: [
      section(
        "how-the-model-works",
        "How the model works",
        p(
          "A funding model assigns part of the available launch capital to a project budget. After the required activation and funding steps complete, reviewers can evaluate milestones according to the published terms. An approved milestone releases its assigned budget to the designated beneficiary.",
        ),
        p(
          "Project capital is separate from the trading market. A token purchase is not an immediate release of every milestone budget. The token's market price remains subject to trading even while review is pending.",
        ),
      ),
      section(
        "roles-and-terms",
        "Roles and terms",
        table(
          ["Role or term", "Meaning"],
          [
            ["Beneficiary", "The recipient of an approved milestone release."],
            [
              "Reviewer",
              "An account permitted to vote under the funding terms.",
            ],
            [
              "Approval threshold",
              "The level of reviewer agreement needed for the milestone decision.",
            ],
            [
              "Budget and deadline",
              "The allocation and timing attached to a milestone.",
            ],
            [
              "Holder",
              "An account that may exercise an available refund right with eligible tokens.",
            ],
          ],
        ),
        p(
          "Reviewers should be identifiable and appropriate to the project. The platform records permitted decisions; it does not verify that an external project deliverable is commercially successful.",
        ),
      ),
      section(
        "release-and-refund",
        "Release and refund",
        p(
          "A release reduces the remaining project budget. Funds already released are not automatically available to a later refund. Where the model enters a refund state, eligible holders can burn tokens for the payout quoted from the remaining capital.",
        ),
        p(
          "Refund eligibility is a state-dependent right. A holder cannot assume that every funding token is refundable at any time. Check the funding page, the current decision state, and the quoted payout before approval.",
        ),
      ),
      section(
        "review-checklist",
        "Review before participating",
        list(
          "Read milestone descriptions, allocations, and deadlines.",
          "Identify reviewers, the approval threshold, and the beneficiary.",
          "Check whether funding is active and what capital remains.",
          "Understand the rejection and deadline-related outcomes defined by the model.",
          "Treat project completion and market performance as separate questions.",
        ),
        p(
          "Use [Holder rights](/docs/holder-rights) to understand the difference between a trade exit and a model-specific refund.",
        ),
      ),
    ],
  },
  {
    slug: "reserve-economy",
    title: "Reserve economies",
    description:
      "Define a funded redemption right that is distinct from selling into the trading market.",
    sections: [
      section(
        "reserve-and-market",
        "Reserve and market",
        p(
          "A reserve model separates assets allocated to holder redemption from assets supporting the trading market. Once the reserve is funded and the right is active, an eligible holder can burn tokens to receive the corresponding reserve payout.",
        ),
        p(
          "A trading quote and a redemption quote answer different questions. Selling depends on the market's current reserves and execution conditions. Redemption depends on the active reserve and the model's accounting of outstanding tokens.",
        ),
      ),
      section(
        "activation-and-coverage",
        "Activation and coverage",
        p(
          "An announced reserve allocation is not the same as an active, funded reserve. Review the reserve page for its state and available assets. The model's name is not evidence that a particular amount is available to every holder.",
        ),
        p(
          "Outstanding supply can include tokens held in markets, allocations, and other wallets. A reserve should not be assessed solely against the visible balance in one account or an informal estimate of circulating supply.",
        ),
      ),
      section(
        "redeem-tokens",
        "Redeem tokens",
        steps(
          "Open the token's reserve page and verify that redemption is active.",
          "Enter an amount of tokens you own and request a redemption quote.",
          "Review the reserve asset, the payout, and the minimum payout bound.",
          "Approve the redemption transaction and wait for finalization.",
          "Check the resulting token balance and received reserve asset.",
        ),
        note(
          "Burning is permanent",
          "A completed redemption reduces your token balance through a burn. It is not a temporary withdrawal and does not preserve those tokens for a second claim.",
        ),
      ),
      section(
        "value-and-constraints",
        "Value and constraints",
        p(
          "A reserve denominated in SOL is a SOL-denominated right. Its value in another currency can change with SOL's price. Reserve value per token and market price can differ, and neither establishes a guaranteed future market price.",
        ),
        p(
          "The currently supported reserve experience requires its accepted supply and activation terms. A simulated reserve amount does not deposit assets or create a live redemption entitlement.",
        ),
      ),
    ],
  },
  {
    slug: "asset-markets",
    title: "Asset-quoted markets",
    description:
      "Explore economies priced in alternative assets while keeping quote denomination separate from ownership and backing.",
    sections: [
      section(
        "quote-denomination",
        "Quote denomination",
        p(
          "The quote asset is the unit used to express prices and settle the market's quoted side. Choosing a different quote changes the units in which an economy is evaluated. A model expressed in one asset should not be compared with another without a clear valuation basis.",
        ),
        p(
          "A quote asset can have its own volatility, transfer behavior, and issuer restrictions. Those conditions remain relevant to the market that uses it.",
        ),
      ),
      section(
        "pairing-is-not-backing",
        "Pairing and backing",
        p(
          "A token paired with a tokenized stock does not become a share of that stock's issuer. A quote pair does not itself grant company ownership, dividends, or the issuer's redemption rights.",
        ),
        p(
          "Actual backing requires a defined asset relationship and an enforceable, funded right. A creator should explain those terms separately from the choice of trading pair.",
        ),
      ),
      section(
        "compatibility-and-availability",
        "Compatibility and availability",
        note(
          "Research scope",
          "Asset-quoted models are available for exploration. Consumer asset-quote launches are currently gated pending an accepted quote adapter and target-specific compatibility. The current release does not claim a live tokenized-stock issuer integration.",
        ),
        list(
          "Confirm the actual asset and its units.",
          "Review token compatibility and any transfer restrictions.",
          "Distinguish quote-asset values from separately estimated currency values.",
          "Check release availability before planning a public launch.",
        ),
      ),
      section(
        "research-an-asset-quote",
        "Research an asset quote",
        p(
          "Use a stated quote asset, initial state, and trade path when researching an alternative-denomination model. Compare output in the model's native units first. Record any separate currency-conversion assumptions so a price change in the quote asset is not mistaken for a change in token reserves.",
        ),
        p(
          "The same research discipline applies to community and funding models. The quote changes how values are expressed; it does not remove the need to review capital, fees, and rights.",
        ),
      ),
    ],
  },
  {
    slug: "simulations",
    title: "Simulation Lab",
    description:
      "Test a specific economic question against explicit assumptions before publishing or launching a model.",
    sections: [
      section(
        "define-the-question",
        "Define the question",
        p(
          "Simulation is most useful when it tests a decision. Ask how a sequence of purchases affects distribution, whether graduation leaves an appropriate destination budget, or how a larger exit compares with a smaller one.",
        ),
        p(
          "Open [Research](/research) with the draft you want to examine. Choose a supported scenario and provide its required inputs. A scenario describes a hypothetical path; it is not a live trade or a deposit.",
        ),
      ),
      section(
        "scenario-families",
        "Scenario families",
        table(
          ["Family", "Questions to examine"],
          [
            [
              "Trading",
              "Single orders, ordered buy/sell sequences, and large exits.",
            ],
            [
              "Graduation",
              "The transition point and the capital available to the destination market.",
            ],
            [
              "Funding and redemption",
              "Supported milestone decisions, remaining capital, and holder payouts.",
            ],
            [
              "Fee behavior",
              "Eligible claims and the distinction between paid, distributed, and reinvested fees.",
            ],
            [
              "Historical replay",
              "A captured path and the assumptions needed for a comparison.",
            ],
          ],
        ),
        p(
          "Scenario availability depends on the model and evidence type. A scenario label alone does not establish that a live launch can execute every action in the scenario.",
        ),
      ),
      section(
        "preview-and-saved-research",
        "Preview and saved research",
        p(
          "A preview provides a quick view of the selected case. Saving research keeps an account-associated run for later inspection. In both cases, record the model version or draft, the input units, the scenario, and any assumptions used in the interpretation.",
        ),
        p(
          "Compare a candidate model against a clearly defined baseline. When several settings change together, an improved metric may not identify which change caused the difference.",
        ),
      ),
      section(
        "simulation-boundary",
        "Understand the boundary",
        note(
          "Evidence is specific",
          "Analytical results depend on stated assumptions and may exclude network fees, account rent, transfer fees, or wallet inventory constraints. Native execution evidence applies to the specific configuration and state tested.",
        ),
        p(
          "A successful run demonstrates the behavior of that case. It does not predict demand, guarantee returns, or certify every possible configuration. Read [Reading results](/docs/reading-results) before comparing models.",
        ),
      ),
    ],
  },
  {
    slug: "stress-testing",
    title: "Stress testing",
    description:
      "Look beyond a favorable example and examine how an economy behaves under less forgiving paths.",
    sections: [
      section(
        "build-a-test-set",
        "Build a test set",
        p(
          "Start with a typical path, then add cases that challenge the intended use. A sequence of small purchases, one large sale, and a mixed buy/sell path reveal different aspects of the same economy.",
        ),
        list(
          "State the order size relative to a clear denominator.",
          "Include small and large orders rather than relying on one output.",
          "Test behavior close to graduation and after the market transition where supported.",
          "Include invalid inputs or unavailable rights and inspect the rejection rather than hiding it.",
        ),
      ),
      section(
        "large-exits",
        "Large exits",
        p(
          "A displayed spot price is not the amount received for every sale. Larger orders can consume a greater share of available liquidity. Compare quoted output, execution fees, and the remaining market state at each tested size.",
        ),
        p(
          "Make the size basis explicit. One percent of total supply, one percent of a holder's balance, and one percent of tokens circulating outside allocations are different tests.",
        ),
      ),
      section(
        "rights-and-capital",
        "Rights and capital scenarios",
        p(
          "For funding, consider approval, rejection, and the model's deadline-related outcomes. Examine what happens after some capital has already been released. For reserve models, compare redemption before activation, after funding, and after earlier eligible redemptions.",
        ),
        p(
          "Capital assigned to a project or reserve cannot be counted again as trading liquidity. Use consistent capital totals when comparing a rights-based economy with a community model.",
        ),
      ),
      section(
        "compare-deliberately",
        "Compare deliberately",
        steps(
          "Keep a documented baseline and the same input path.",
          "Change one setting or one coherent group of settings.",
          "Compare accepted cases, rejected cases, and capital consequences.",
          "Repeat at more than one trade size.",
          "Record the conclusion together with the tested range and the unresolved assumptions.",
        ),
        p(
          "Stress testing can reveal tradeoffs. The purpose is to identify conditions under which a model is useful, rather than to manufacture a single favorable ranking.",
        ),
      ),
    ],
  },
  {
    slug: "reading-results",
    title: "Reading results",
    description:
      "Separate calculated behavior, observed execution, and the conclusions that each type of evidence can support.",
    sections: [
      section(
        "evidence-levels",
        "Evidence levels",
        table(
          ["Evidence", "Supports", "Does not establish"],
          [
            [
              "Analytical preview",
              "Calculated behavior under the selected assumptions.",
              "Successful live execution or future demand.",
            ],
            [
              "Native simulation",
              "Execution behavior for the tested configuration and state.",
              "Universal support for every parameter combination.",
            ],
            [
              "Devnet lifecycle",
              "End-to-end operation of the tested flow on devnet.",
              "Production readiness, an audit, or mainnet liquidity.",
            ],
            [
              "Historical replay",
              "A comparison tied to the captured period and its assumptions.",
              "A complete counterfactual trading history.",
            ],
          ],
        ),
      ),
      section(
        "read-units-and-fees",
        "Read units and fees",
        p(
          "Identify the token and quote units before interpreting a value. Decide whether the output includes trading fees and whether other costs are excluded. A quote-asset amount is not automatically a currency-denominated profit figure.",
        ),
        p(
          "A price impact or shortfall metric needs a reference price and an order-size basis. If those are unclear, the percentage alone is not a meaningful comparison.",
        ),
      ),
      section(
        "read-capital-and-rights",
        "Read capital and rights",
        p(
          "Inspect the destination budget, project allocation, reserve allocation, and any supported fee treatment separately. Avoid treating the same assets as both reserve coverage and freely available market liquidity.",
        ),
        p(
          "A hypothetical payout requires hypothetical inputs. An observed live entitlement requires the corresponding right to be active and funded. The result of a scenario does not create those conditions.",
        ),
      ),
      section(
        "write-a-bounded-conclusion",
        "Write a bounded conclusion",
        list(
          "Name the model or version and scenario.",
          "Record the initial conditions and trade sizes.",
          "State which results were calculated and which were observed.",
          "Explain the benefit together with its capital or fee tradeoff.",
          "Keep unanswered questions visible rather than treating them as passed checks.",
        ),
        p(
          "A useful conclusion describes the conditions under which the model behaved as intended. It avoids converting a successful technical case into a general market-performance claim.",
        ),
      ),
    ],
  },
  {
    slug: "swaps",
    title: "Buying and selling",
    description:
      "Review a quote, set an execution tolerance, and follow a trade through the active market.",
    sections: [
      section(
        "identify-the-market",
        "Identify the market",
        p(
          "Open the token page and inspect its current market stage. Before graduation, trading uses the launch market. After completed migration, the destination market supplies the quote. The current stage matters because the two markets can have different execution behavior.",
        ),
        p(
          "Review token identity, the quote asset, and any supported holder rights. A buy or sell uses a market; it is different from exercising a reserve redemption or a funding refund.",
        ),
      ),
      section(
        "review-a-quote",
        "Review a quote",
        list(
          "Confirm whether you are buying or selling.",
          "Check the input amount and expected output in the displayed units.",
          "Review the trading fee and the minimum output or maximum input bound.",
          "Check slippage tolerance and your available balance.",
          "Approve only after the quote reflects the trade you intend to make.",
        ),
        p(
          "A quote describes a current execution estimate. Other activity and network delay can change market state before a submitted transaction executes.",
        ),
      ),
      section(
        "price-impact-and-slippage",
        "Price impact and slippage",
        p(
          "Price impact describes how the size of an order affects its execution relative to a reference price. Slippage tolerance defines an acceptance boundary for the submitted trade. A tolerance setting does not add liquidity or guarantee execution.",
        ),
        note(
          "Use a considered tolerance",
          "A tighter bound can reject a trade when state changes. A wider bound permits a less favorable execution. Review the bound in actual asset units rather than considering only the percentage.",
        ),
      ),
      section(
        "after-submission",
        "After submission",
        p(
          "Follow the transaction in Activity and wait for its recorded outcome. If a quote expires or the trade is rejected, request a fresh quote before another approval. If the outcome is still pending, investigate that receipt before preparing a separate trade.",
        ),
        p(
          "A finalized trade changes balances according to its executed result. Its outcome does not establish a future exit price for the tokens received.",
        ),
      ),
    ],
  },
  {
    slug: "graduation",
    title: "Graduation",
    description:
      "Understand the move from initial price discovery to a destination market, including the activation of supported capital rights.",
    sections: [
      section(
        "the-transition",
        "The transition",
        p(
          "A DepthGuard launch begins its market lifecycle through Meteora DBC. Graduation is the transition into a Meteora DAMM v2 market once the required launch condition is met and the migration steps complete.",
        ),
        p(
          "The threshold describes a launch condition. Reaching it is not the same as completing every subsequent operation. Inspect the recorded phase and destination market before treating migration as complete.",
        ),
      ),
      section(
        "capital-at-graduation",
        "Capital at graduation",
        p(
          "The model determines how eligible capital is assigned. Destination liquidity, a project budget, reserve funding, and applicable costs have different purposes. Allocations should be reviewed as a combined capital plan.",
        ),
        p(
          "A funding or reserve right becomes usable only when its required activation and funding state is established. A progress indicator near graduation does not by itself establish a holder payout.",
        ),
      ),
      section(
        "secondary-market-behavior",
        "Secondary market behavior",
        p(
          "The destination market has its own reserves and trading costs. Its response to a sale depends on available capital and order size. A smooth transition in one scenario does not establish a fixed secondary-market price or unlimited exit capacity.",
        ),
        list(
          "Inspect the destination market after completion.",
          "Request a current quote for the actual order size.",
          "Separate locked liquidity from price stability.",
          "Review the state of any holder-rights module independently.",
        ),
      ),
      section(
        "pending-transitions",
        "Pending transitions",
        p(
          "If migration or activation remains pending, check the launch workspace and related receipts. A temporary interface delay should not prompt a second token launch. Preserve the existing reference and review its recorded state.",
        ),
        p(
          "[Transactions](/docs/transactions) explains how to follow a submitted action. [Holder rights](/docs/holder-rights) explains what becomes available after activation.",
        ),
      ),
    ],
  },
  {
    slug: "holder-rights",
    title: "Holder rights",
    description:
      "Know what holding a token permits, which conditions apply, and how a market exit differs from a funded claim.",
    sections: [
      section(
        "rights-are-model-specific",
        "Rights are model-specific",
        p(
          "Holding a token does not automatically grant a claim on a project, business, reserve, or future fee stream. Rights depend on the chosen model and its actual active state. Review the token's dedicated rights page where one is available.",
        ),
        table(
          ["Action", "Basis", "Important distinction"],
          [
            [
              "Sell in the market",
              "Current trading quote and liquidity.",
              "An execution price, not a reserve entitlement.",
            ],
            [
              "Reserve redemption",
              "An active, funded reserve and eligible tokens.",
              "Tokens are burned for the quoted reserve payout.",
            ],
            [
              "Funding refund",
              "An eligible refund state and remaining capital.",
              "Previously released project funds are not automatically recovered.",
            ],
            [
              "Reviewer vote",
              "The reviewer's role in the funding terms.",
              "Holding a token alone does not make an account a reviewer.",
            ],
          ],
        ),
      ),
      section(
        "check-eligibility",
        "Check eligibility",
        list(
          "Verify the token and model reference.",
          "Check whether the relevant right is active.",
          "Inspect the actual reserve or remaining budget.",
          "Use tokens owned by the connected account.",
          "Request a current payout quote and review its minimum bound.",
        ),
      ),
      section(
        "exercise-a-right",
        "Exercise a right",
        p(
          "The rights page presents the available action for the current state. A redemption or refund can require a burn of your tokens. Review the effect on both balances before approving, and wait for a finalized receipt before treating the payout as received.",
        ),
        p(
          "Rounding and current reserve state can matter for small amounts. A displayed market value does not replace the actual payout quote.",
        ),
      ),
      section(
        "when-an-action-is-unavailable",
        "When an action is unavailable",
        p(
          "An unavailable action may mean the module is not active, the funding decision is still pending, the account lacks the required role, or the proposed amount is outside its permitted balance. Review the specific state instead of assuming a general platform outage.",
        ),
        p(
          "See [Milestone funding](/docs/milestone-funding) or [Reserve economies](/docs/reserve-economy) for the relevant conditions.",
        ),
      ),
    ],
  },
  {
    slug: "reuse-models",
    title: "Use and fork models",
    description:
      "Start from published economic rules while preserving a clear distinction between attribution and your new launch.",
    sections: [
      section(
        "inspect-a-model",
        "Inspect a model",
        p(
          "The [model library](/models) contains published economy versions. Review the mechanism, author, version, fee policy, and supported capabilities before selecting one. A model's popularity does not replace that review.",
        ),
        p(
          "Read the model in the context of your purpose. A curve designed for a community experiment may not provide the funding or redemption terms needed by a different project.",
        ),
      ),
      section(
        "use-an-existing-version",
        "Use an existing version",
        p(
          "Using a version carries its accepted economic rules into a new token creation flow. You provide the new token identity and the instance inputs required for the launch. The published author policy remains part of the selected version.",
        ),
        p(
          "Reuse does not copy the original token's holders, trading history, liquidity balance, reserves, or project funds. Every new instance requires its own establishment and funding.",
        ),
      ),
      section(
        "fork-and-import",
        "Fork and import",
        p(
          "Fork a model when the economic settings need to change. An official fork records its relationship to the starting model. The current official fork path preserves the registered author fee policy; it does not automatically add a new fee entitlement for each successive fork.",
        ),
        p(
          "Importing a shared model is a way to transfer model settings. A successful import is not proof that the model is launch-ready or endorsed. Review its identity, author attribution, configuration, and capability status before use.",
        ),
      ),
      section(
        "compare-before-adoption",
        "Compare before adoption",
        steps(
          "Inspect the published version and its intended use.",
          "Run a representative scenario without changing the original rules.",
          "Fork only if your purpose requires a modification.",
          "Validate and compare the modified model.",
          "Review the final author policy and launch terms before publication or use.",
        ),
      ),
    ],
  },
  {
    slug: "model-authors",
    title: "For model authors",
    description:
      "Publish economic designs that other creators can understand, research, and reuse.",
    sections: [
      section(
        "an-authoring-workflow",
        "An authoring workflow",
        p(
          "A mechanism author designs reusable economic rules rather than merely choosing a token name. The value of a model is the clarity of its purpose, the coherence of its parameters, and the quality of the evidence supporting its intended behavior.",
        ),
        steps(
          "Define a specific user need and an appropriate starting mechanism.",
          "Build and validate the draft in Economy Studio.",
          "Research representative trading and rights scenarios.",
          "Publish a version with accurate attribution and a reviewed fee policy.",
          "Help launchers understand the model's useful conditions and tradeoffs.",
        ),
      ),
      section(
        "describe-the-model",
        "Describe the model clearly",
        list(
          "Explain who the model is designed for.",
          "Describe the rights it provides and the rights it does not provide.",
          "State the capital tradeoffs and relevant activation conditions.",
          "Keep research claims tied to the tested cases.",
          "Avoid presenting a model as audited or profitable without the corresponding evidence.",
        ),
      ),
      section(
        "adoption-and-fees",
        "Adoption and fees",
        p(
          "The official reuse path associates a launch with the model's registered attribution and fee policy. An eligible author share is drawn from the actual claimable trading-fee stream under that policy. It is not a charge on all project capital or a promise of recurring income.",
        ),
        p(
          "No trading activity means no trading-fee revenue from that activity. Pending accrual, funds available for distribution, and amounts received are different stages; use Earnings to inspect the relevant state.",
        ),
      ),
      section(
        "attribution-boundary",
        "Attribution boundary",
        p(
          "The published fee policy applies to supported launches made through the official model flow. Independent deployments outside that flow are not represented as automatically subject to the same attribution or fee obligations.",
        ),
        p(
          "The current fork policy does not stack royalties for every contributor in a chain of forks. Review [Fees and earnings](/docs/fees-and-earnings) before describing an author's entitlement.",
        ),
      ),
    ],
  },
  {
    slug: "fees-and-earnings",
    title: "Fees & earnings",
    description:
      "Separate the cost of an action from the fee stream that eligible participants can claim.",
    sections: [
      section(
        "types-of-cost",
        "Types of cost",
        table(
          ["Cost", "When relevant", "Treatment"],
          [
            [
              "Network fee",
              "A submitted Solana transaction.",
              "Paid according to the transaction; separate from a trading fee.",
            ],
            [
              "Account creation",
              "A workflow needs new accounts.",
              "Can require additional SOL beyond the intended purchase.",
            ],
            [
              "Trading fee",
              "An executed buy or sell.",
              "Included in the current quote's fee treatment.",
            ],
            [
              "Model allocations",
              "The economic rules assign capital.",
              "Capital use, not automatically an author royalty.",
            ],
          ],
        ),
        p(
          "Review the approval and quote for the current action rather than assuming every launch or trade has an identical cost. The present release uses test assets on devnet.",
        ),
      ),
      section(
        "eligible-fee-stream",
        "Eligible fee stream",
        p(
          "The fee policy divides the eligible claimable trading-fee stream among its recipients. Protocol deductions and any fee treatment that retains value in liquidity affect what is actually available to distribute. Trade volume and gross trading fees are not the same as recipient earnings.",
        ),
        p(
          "A commonly used starting policy allocates 80% of eligible fees to the launcher, 10% to the model author, and 10% to the platform. Check the selected model's actual policy. When the same account is launcher and author, its listed roles can both contribute to its total share.",
        ),
      ),
      section(
        "principal-is-separate",
        "Capital is separate",
        p(
          "Trading liquidity, a project's milestone budget, and reserve assets are separate capital categories. They are not counted again as royalties. Fees reinvested into liquidity cannot also be described as cash already paid to recipients.",
        ),
        p(
          "Native fee sharing connects eligible fee collections to the supported distribution experience. A recipient's earnings depend on amounts actually available under the deployed policy.",
        ),
      ),
      section(
        "claim-and-review",
        "Claim and review",
        steps(
          "Open Earnings with the eligible account connected and authenticated.",
          "Inspect the source, recipient share, and amount available to claim.",
          "Approve the presented claim action.",
          "Wait for the receipt to finalize and verify the resulting balance.",
        ),
        note(
          "Claims are not forecasts",
          "A pending or completed claim reflects eligible activity already accounted for. It does not predict future trading volume, token performance, or future recipient income.",
        ),
      ),
    ],
  },
  {
    slug: "transactions",
    title: "Transaction lifecycle",
    description:
      "Follow an action from wallet approval to a recorded outcome and recover without confusing delay with failure.",
    sections: [
      section(
        "understand-the-status",
        "Understand the status",
        table(
          ["Status", "Interpretation", "What to do"],
          [
            [
              "Prepared",
              "An action is ready for wallet review; it has not completed.",
              "Check the intent and approve if correct.",
            ],
            [
              "Submitted",
              "A signed action has entered the submission workflow.",
              "Follow the recorded receipt.",
            ],
            [
              "Confirmed",
              "The network has observed the transaction at an intermediate commitment.",
              "Wait for the final outcome required by the workflow.",
            ],
            [
              "Finalized",
              "The transaction reached the required final commitment.",
              "Review balances and the next workflow step.",
            ],
            [
              "Expired or failed",
              "The transaction could not complete as prepared, or execution was rejected.",
              "Review the reason and request a new action where appropriate.",
            ],
          ],
        ),
      ),
      section(
        "multi-step-workflows",
        "Multi-step workflows",
        p(
          "Publishing, launching, migration, or exercising a right can involve more than one action. Completing an early step does not establish that later steps completed. The launch workspace records progression so you can return to the same instance.",
        ),
        p(
          "Keep the reference to the existing workflow. If a browser closes or a connection interrupts, inspect its current state before creating a new launch or a separate trade.",
        ),
      ),
      section(
        "recover-deliberately",
        "Recover deliberately",
        list(
          "If you rejected a wallet prompt, return to the pending action and review it again.",
          "If a submission is pending, inspect Activity before repeating it.",
          "If an action expired, obtain a fresh prepared action and review the new prompt.",
          "If a quote was rejected, refresh the quote and reconsider the amount or execution bound.",
          "If a capability is unavailable, review the model and release status rather than widening transaction settings.",
        ),
      ),
      section(
        "finalization-and-verification",
        "Finalization and verification",
        p(
          "A successful submission response is not the same as finalization. Use the recorded outcome together with the displayed market, balance, and rights state. A finalized earlier step can coexist with a later action that still needs attention.",
        ),
        p(
          "For an issue that persists, keep the transaction reference and the operation you attempted. Never provide a recovery phrase or private key as part of a support request.",
        ),
      ),
    ],
  },
  {
    slug: "security",
    title: "Security & trust",
    description:
      "A clear view of account authorization, model terms, and the limits of the current release.",
    sections: [
      section(
        "account-authorization",
        "Account authorization",
        p(
          "DepthGuard separates browsing, application authentication, and transaction approval. Authentication proves control of the selected account for an application session. A transaction prompt authorizes its presented on-chain action.",
        ),
        list(
          "Use the official HTTPS domain and verify the requesting origin.",
          "Keep recovery phrases and private keys in your wallet's custody.",
          "Review token identity, recipients, amounts, and intent before approval.",
          "Inspect the recorded transaction outcome rather than relying on a browser notification alone.",
        ),
      ),
      section(
        "model-transparency",
        "Model transparency",
        p(
          "Review the version actually selected for a launch. Inspect its mechanism, fee policy, capital use, and supported rights. A registered version supports clear identification; it does not independently assess the economic quality or external promises of a project.",
        ),
        p(
          "Research should support the claims made about a model. A successful small-order example does not establish behavior at all order sizes, and a liquidity lock does not establish price protection.",
        ),
      ),
      section(
        "release-boundaries",
        "Release boundaries",
        note(
          "Current assurance scope",
          "The current deployment has completed specific devnet lifecycle tests. Independent security review, production acceptance, and broader operational validation are separate requirements. The application does not claim that devnet acceptance is an audit.",
        ),
        p(
          "A feature's availability and its assurance scope should both be reviewed. [Release status](/docs/release-status) records the present product boundary.",
        ),
      ),
      section(
        "reporting-an-issue",
        "Investigating an issue",
        p(
          "Record the affected page, intended action, network, and transaction reference where available. Share only information needed to identify the event. Account secrets and signed wallet authorization material are not appropriate troubleshooting attachments.",
        ),
        p(
          "If a prompt does not match the intended action, reject it and inspect the application state. If an action was already submitted, check its receipt before attempting another operation.",
        ),
      ),
    ],
  },
  {
    slug: "release-status",
    title: "Release status",
    description:
      "The current deployment, tested workflows, and capabilities that remain subject to additional acceptance.",
    sections: [
      section(
        "deployment",
        "Current deployment",
        p(
          "DepthGuard is currently offered as a Solana devnet preview. The application connects the creator and trading interface to real devnet workflows. Test assets and test liquidity are used throughout this release.",
        ),
        p(
          "This page describes product availability as of October 3, 2026. A feature described as research-only should not be presented as an accepted consumer launch capability.",
        ),
      ),
      section(
        "capability-matrix",
        "Capability matrix",
        table(
          ["Capability", "Current scope"],
          [
            [
              "Community launch",
              "Devnet lifecycle accepted, including DBC trading and migration to DAMM v2.",
            ],
            [
              "Milestone funding",
              "Devnet activation, reviewer decisions, milestone release, and an eligible refund tested.",
            ],
            [
              "Reserve economy",
              "Devnet activation and burn redemption tested.",
            ],
            [
              "Fee sharing",
              "Eligible native fee collection and recipient claims tested on devnet.",
            ],
            [
              "Model design and reuse",
              "Consumer authoring, publication, and official reuse workflows; detailed capability checks still apply.",
            ],
            [
              "Asset-quoted launches",
              "Research scope; consumer launch path requires an accepted quote adapter.",
            ],
            [
              "DLMM strategies",
              "Potential expansion; not part of the accepted current launch lifecycle.",
            ],
            ["Mainnet production", "Not enabled by this release."],
          ],
        ),
      ),
      section(
        "interpreting-acceptance",
        "Interpreting acceptance",
        p(
          "Devnet acceptance demonstrates the tested lifecycle with its selected configurations. It does not establish independent audit status, mainnet liquidity, production load capacity, or universal compatibility with every wallet and quote asset.",
        ),
        p(
          "Live market values remain specific to each launch. A completed test does not supply liquidity or reserve funding to another token instance.",
        ),
      ),
      section(
        "future-scope",
        "Future scope",
        p(
          "Broader asset support, additional liquidity strategies, and production availability require their own compatibility and operational acceptance. Documentation will describe those capabilities when the corresponding release supports them.",
        ),
        p(
          "Until then, use the capability information shown by the application and distinguish research inputs from accepted launch actions.",
        ),
      ),
    ],
  },
  {
    slug: "glossary",
    title: "Glossary",
    description:
      "The product and market terms used throughout the DepthGuard handbook.",
    sections: [
      section(
        "models-and-identity",
        "Models and identity",
        table(
          ["Term", "Meaning"],
          [
            [
              "Economy model",
              "The reusable rules that describe a token's supported pricing, capital, fees, and rights.",
            ],
            [
              "Draft",
              "An editable workspace that has not yet established a published version.",
            ],
            ["Version", "An identified publication of a model's terms."],
            [
              "Author",
              "The attributed creator associated with a model's registered policy.",
            ],
            [
              "Launcher",
              "The account creating a new token instance from a model.",
            ],
            [
              "Fork",
              "A modified model derived through a supported relationship to an existing version.",
            ],
          ],
        ),
      ),
      section(
        "markets-and-execution",
        "Markets and execution",
        table(
          ["Term", "Meaning"],
          [
            [
              "DBC",
              "Meteora Dynamic Bonding Curve, used for initial token price discovery.",
            ],
            [
              "DAMM v2",
              "The Meteora market used as the current destination after graduation.",
            ],
            [
              "Quote asset",
              "The asset used to express prices and settle the quoted side of a market.",
            ],
            [
              "Graduation",
              "The completed transition from a launch market to its destination market.",
            ],
            [
              "Price impact",
              "The effect of an order's size on its execution relative to a reference price.",
            ],
            [
              "Slippage tolerance",
              "The permitted execution boundary for a submitted trade.",
            ],
            [
              "Finalized",
              "The required final commitment reached by a recorded transaction.",
            ],
          ],
        ),
      ),
      section(
        "capital-and-claims",
        "Capital and claims",
        table(
          ["Term", "Meaning"],
          [
            ["Liquidity", "Assets supporting execution in a trading market."],
            [
              "Reserve",
              "Funded assets available under a model's active redemption terms.",
            ],
            [
              "Burn",
              "A permanent reduction of the token amount owned and supplied.",
            ],
            [
              "Redemption",
              "A permitted token burn in exchange for the quoted reserve payout.",
            ],
            [
              "Milestone",
              "A defined stage in a project's funding release schedule.",
            ],
            [
              "Beneficiary",
              "The account receiving an approved project-funding release.",
            ],
            [
              "Claimable fees",
              "The eligible fee amount available under the actual distribution policy.",
            ],
            [
              "DFS",
              "Meteora Dynamic Fee Sharing, used in the supported fee-distribution experience.",
            ],
          ],
        ),
      ),
      section(
        "research-and-release",
        "Research and release",
        table(
          ["Term", "Meaning"],
          [
            [
              "Analytical preview",
              "Calculated behavior under selected inputs and stated assumptions.",
            ],
            [
              "Stress test",
              "A case chosen to examine behavior under a challenging path.",
            ],
            [
              "Baseline",
              "The reference model and conditions used in a comparison.",
            ],
            [
              "Historical replay",
              "A comparison based on a captured period and explicit assumptions.",
            ],
            [
              "Devnet",
              "Solana's development network for test assets and network workflows.",
            ],
            [
              "Capability",
              "A behavior accepted by the model and supported by the current release.",
            ],
          ],
        ),
      ),
    ],
  },
  {
    slug: "faq",
    title: "Frequently asked questions",
    description:
      "Practical answers about models, launches, trading, rights, and the current release.",
    sections: [
      section("getting-started", "Getting started", {
        type: "faq",
        items: [
          {
            question: "Do I need a wallet to read or research?",
            answer:
              "No. Public browsing and available previews do not require authentication. Saving account-associated work, publishing, and transactional actions require the appropriate account and signing features.",
          },
          {
            question: "Is the current application on mainnet?",
            answer:
              "No. The present release uses Solana devnet and test assets. Mainnet production is not enabled by this release.",
          },
          {
            question: "Why do I sign a message before a transaction?",
            answer:
              "The message establishes an application session for the selected account. A later transaction prompt authorizes an on-chain action. The two approvals have different purposes.",
          },
        ],
      }),
      section("models-and-launches", "Models and launches", {
        type: "faq",
        items: [
          {
            question: "Can I launch from someone else's model?",
            answer:
              "Yes, through the supported reuse workflow. Review its version, author policy, economic settings, and capability status before providing your new token's identity and instance inputs.",
          },
          {
            question: "Does copying a model copy its liquidity or holders?",
            answer:
              "No. A new launch is a separate instance. It does not inherit another token's holders, trading history, balances, reserves, or project capital.",
          },
          {
            question: "Can I run any mathematical curve?",
            answer:
              "The model can customize supported native curve behavior. Arbitrary economic formulas are not automatically executable, and visible research inputs can still be unavailable for launch.",
          },
          {
            question: "Can I change a live launch by editing my draft?",
            answer:
              "No. Editing a draft does not rewrite a published version or alter an existing market's deployed terms.",
          },
        ],
      }),
      section("trading-and-rights", "Trading and rights", {
        type: "faq",
        items: [
          {
            question: "Does graduation guarantee a stable price?",
            answer:
              "No. The destination market has its own reserves, fees, and order-size behavior. Graduation is a lifecycle transition, not a price guarantee.",
          },
          {
            question: "Does a reserve token always trade at reserve value?",
            answer:
              "No. Market price and a reserve redemption payout are different. Check the active reserve and the current redemption quote separately from the market quote.",
          },
          {
            question: "Can a funding refund recover all project spending?",
            answer:
              "A refund is governed by the model's eligible state and remaining capital. Project funds already released to a beneficiary are not automatically returned to the refund budget.",
          },
          {
            question: "Does an asset quote make my token a stock?",
            answer:
              "No. Quote denomination does not itself create ownership, dividends, issuer redemption, or asset backing. Asset-quoted consumer launches also remain gated in this release.",
          },
        ],
      }),
      section("earnings-and-recovery", "Earnings and recovery", {
        type: "faq",
        items: [
          {
            question: "Are author earnings taken from the project's reserve?",
            answer:
              "No. The supported author policy applies to the eligible claimable trading-fee stream. Project capital, reserve assets, and trading liquidity are separate categories.",
          },
          {
            question: "What should I do when a transaction appears stuck?",
            answer:
              "Check Activity and the existing workflow reference. Distinguish a pending submission from an expired or failed action before requesting a new approval.",
          },
          {
            question:
              "Does a successful simulation prove the token will succeed?",
            answer:
              "No. It supports conclusions about the selected case and assumptions. It does not establish demand, future returns, an independent audit, or production acceptance.",
          },
        ],
      }),
    ],
  },
  ...mathPages,
];
export const docBySlug = new Map(docPages.map((page) => [page.slug, page]));
export function blockText(block: DocBlock): string {
  if (block.type === "paragraph" || block.type === "note") return block.text;
  if (block.type === "equation") return `${block.title} ${block.caption}`;
  if (block.type === "diagram") return "Economic illustration";
  if (block.type === "list" || block.type === "steps")
    return block.items.join(" ");
  if (block.type === "table") return block.rows.flat().join(" ");
  return block.items.map((item) => `${item.question} ${item.answer}`).join(" ");
}
export function readingMinutes(page: DocPage): number {
  const words = page.sections
    .flatMap((s) => s.blocks.map(blockText))
    .join(" ")
    .split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 200));
}
export type SearchResult = {
  page: DocPage;
  section?: DocSection;
  excerpt: string;
};
export function searchDocs(query: string): SearchResult[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const ranked: (SearchResult & { rank: number })[] = [];
  for (const page of docPages) {
    const title = `${page.title} ${page.description}`.toLowerCase();
    for (const s of page.sections) {
      const body = s.blocks.map(blockText).join(" ");
      const searchable = `${title} ${s.title} ${body}`.toLowerCase();
      if (!terms.every((term) => searchable.includes(term))) continue;
      const rank = terms.reduce(
        (score, term) =>
          score +
          (page.title.toLowerCase().includes(term) ? 8 : 0) +
          (s.title.toLowerCase().includes(term) ? 4 : 0),
        0,
      );
      const position = Math.max(0, body.toLowerCase().indexOf(terms[0]) - 45);
      const excerpt =
        body
          .slice(position, position + 150)
          .replace(/\*\*|\[|\]\([^)]*\)/g, "") +
        (body.length > position + 150 ? "…" : "");
      ranked.push({ page, section: s, excerpt, rank });
    }
  }
  return ranked.sort((a, b) => b.rank - a.rank).slice(0, 18);
}
