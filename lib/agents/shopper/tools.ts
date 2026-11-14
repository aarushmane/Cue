// Shopper agent tools. Each tool wraps deterministic code (search, routing). Tools mutate `nav` and may queue
// route text to be spoken VERBATIM — the model never writes directions itself.
import type Anthropic from "@anthropic-ai/sdk";
import { getRepo } from "../../db/repo";
import { planRoute } from "../../routing/plan";
import { describeProduct, resolveProduct, searchProducts } from "../../search/matchProducts";
import type { PublishedProduct, RouteResult } from "../../types";
import type { ShopperNav } from "./state";

export interface ToolContext {
  nav: ShopperNav;
  /** Route instructions to append, word for word, after the agent's reply. */
  spoken: string[];
  choices: string[];
  reports: { product_id: string | null; note: string }[];
}

const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object" as const, properties, required, additionalProperties: false });

export const SHOPPER_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_products",
    description: "Search this store's verified inventory. Use the shopper's words. Returns matches with ids, spoken names and aisle; tells you if the shopper must choose between variants.",
    input_schema: obj({ query: { type: "string", description: "What the shopper asked for, e.g. 'almond milk'" } }, ["query"]),
    strict: true,
  },
  {
    name: "select_product",
    description: "Set the shopper's destination product. Only call with an id returned by search_products, after the shopper has chosen when there were several.",
    input_schema: obj({ product_id: { type: "string" } }, ["product_id"]),
    strict: true,
  },
  {
    name: "get_position",
    description: "Get the shopper's current mapped position and how confident it is. If unknown, ask the shopper to tap Scan and slowly pan their phone.",
    input_schema: obj({}, []),
    strict: true,
  },
  {
    name: "start_route",
    description: "Compute a route from the shopper's position to the selected product and read the first instruction. Requires a selected product and a CONFIRMED or LIKELY position.",
    input_schema: obj({}, []),
    strict: true,
  },
  {
    name: "next_step",
    description: "The shopper finished the current instruction; read the next one. Re-checks the product's location, so it reroutes if staff moved it.",
    input_schema: obj({}, []),
    strict: true,
  },
  { name: "repeat_step", description: "Read the current instruction again.", input_schema: obj({}, []), strict: true },
  { name: "previous_step", description: "Go back and read the previous instruction.", input_schema: obj({}, []), strict: true },
  {
    name: "set_preferences",
    description: "Change how the assistant talks: concise or detailed replies, and speech rate (0.5–2, 1 is normal).",
    input_schema: obj(
      {
        verbosity: { type: ["string", "null"], enum: ["concise", "detailed", null] },
        speech_rate: { type: ["number", "null"] },
      },
      ["verbosity", "speech_rate"],
    ),
    strict: true,
  },
  {
    name: "report_issue",
    description: "Send store staff a note, e.g. the product is not on the shelf. This never changes inventory.",
    input_schema: obj({ note: { type: "string" } }, ["note"]),
    strict: true,
  },
  {
    name: "request_help",
    description: "The shopper wants a person to help, or guidance is not possible. Tells them how to get help.",
    input_schema: obj({}, []),
    strict: true,
  },
];

type Result = Record<string, unknown>;

async function storeData(nav: ShopperNav) {
  const repo = getRepo();
  const [graph, products] = await Promise.all([repo.getPublishedGraph(nav.store_id), repo.listPublishedProducts(nav.store_id)]);
  return { graph, products };
}

function summarize(p: PublishedProduct) {
  return { product_id: p.id, spoken_name: describeProduct(p), aisle: p.shelf.aisle, section: p.shelf.section };
}

function speakStep(ctx: ToolContext, route: Extract<RouteResult, { steps: unknown }>, index: number) {
  const step = route.steps[index];
  if (step) ctx.spoken.push(step.text);
  return { step_number: index + 1, total_steps: route.steps.length, is_final_step: index === route.steps.length - 1 };
}

/** Recompute the active route from its start node against the CURRENT published location of the product. */
async function currentRoute(ctx: ToolContext) {
  const { nav } = ctx;
  const { graph, products } = await storeData(nav);
  if (!graph || !nav.route_start_node_id || !nav.product_id) return null;
  const product = products.find((p) => p.id === nav.product_id) ?? null;
  return planRoute(graph, nav.route_start_node_id, product);
}

export async function runShopperTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<Result> {
  const { nav } = ctx;
  switch (name) {
    case "search_products": {
      const query = String(input.query ?? "");
      const { products } = await storeData(nav);
      const resolution = resolveProduct(query, products);
      if (resolution.status === "NO_MATCH") {
        nav.state = "SEARCHING";
        return { status: "NO_MATCH", note: "Nothing in this store's verified inventory matches. Ask the shopper to rephrase or name another item." };
      }
      if (resolution.status === "AMBIGUOUS") {
        nav.candidate_product_ids = resolution.options.map((p) => p.id);
        ctx.choices = resolution.options.map(describeProduct);
        return { status: "AMBIGUOUS", options: resolution.options.map(summarize), note: "Ask the shopper which one. Do not choose for them." };
      }
      nav.candidate_product_ids = [resolution.product.id];
      return { status: "MATCH", product: summarize(resolution.product), other_results: searchProducts(query, products, 4).slice(1).map((r) => summarize(r.product)) };
    }

    case "select_product": {
      const { products } = await storeData(nav);
      const p = products.find((x) => x.id === input.product_id);
      if (!p) return { error: "Unknown or unpublished product id. Use an id from search_products." };
      nav.product_id = p.id;
      nav.route_start_node_id = null;
      nav.destination_shelf_id = null;
      nav.step_index = 0;
      ctx.choices = [];
      nav.state = nav.position_confidence === "UNKNOWN" ? "LOCATING" : "DESTINATION_SELECTED";
      return { selected: summarize(p), position_known: nav.position_confidence !== "UNKNOWN" };
    }

    case "get_position": {
      if (!nav.current_node_id || nav.position_confidence === "UNKNOWN") {
        nav.state = "LOCATING";
        return { position: "UNKNOWN", note: "Ask the shopper to tap Scan and slowly pan the phone left to right. Do not give directions." };
      }
      const { graph } = await storeData(nav);
      const node = graph?.nodes.find((n) => n.id === nav.current_node_id);
      return { position: nav.position_confidence, near: node?.label ?? "an unlabeled point" };
    }

    case "start_route": {
      if (!nav.product_id) return { error: "No product selected yet." };
      if (!nav.current_node_id || nav.position_confidence === "UNKNOWN") {
        nav.state = "LOCATING";
        return { error: "POSITION_UNKNOWN", note: "Ask the shopper to scan. Never give turn-by-turn guidance without a position." };
      }
      nav.route_start_node_id = nav.current_node_id;
      nav.step_index = 0;
      const route = await currentRoute(ctx);
      if (!route || (route.status !== "OK" && route.status !== "ALREADY_THERE")) {
        nav.state = "NEEDS_HELP";
        return { error: route?.status ?? "ROUTE_UNAVAILABLE", reason: route && "reason" in route ? route.reason : "No route.", note: "Offer to send a staff request." };
      }
      nav.destination_shelf_id = route.destinationShelfId;
      nav.state = route.status === "ALREADY_THERE" ? "ARRIVED" : "GUIDING";
      const spoken = speakStep(ctx, route, route.status === "ALREADY_THERE" ? route.steps.length - 1 : 0);
      return { status: route.status, ...spoken, position_was: nav.position_confidence, note: "The instruction is read to the shopper automatically. Do not repeat or rephrase it." };
    }

    case "next_step":
    case "repeat_step":
    case "previous_step": {
      let route = await currentRoute(ctx);
      if (!route || (route.status !== "OK" && route.status !== "ALREADY_THERE")) return { error: "No active route. Use start_route." };

      // Dynamic update: staff moved the product since the route started → reroute from where the shopper is now.
      let rerouted = false;
      if (route.destinationShelfId !== nav.destination_shelf_id) {
        const here = route.steps[Math.min(nav.step_index, route.steps.length - 1)]?.fromNodeId ?? nav.route_start_node_id;
        nav.route_start_node_id = here;
        nav.current_node_id = here;
        nav.step_index = 0;
        route = await currentRoute(ctx);
        if (!route || (route.status !== "OK" && route.status !== "ALREADY_THERE")) return { error: "ROUTE_UNAVAILABLE after the store updated this product's location." };
        nav.destination_shelf_id = route.destinationShelfId;
        rerouted = true;
        ctx.spoken.push("The store just updated where this item is. Rerouting.");
      } else if (name === "next_step") {
        nav.step_index = Math.min(nav.step_index + 1, route.steps.length - 1);
      } else if (name === "previous_step") {
        nav.step_index = Math.max(nav.step_index - 1, 0);
      }
      const atEnd = nav.step_index === route.steps.length - 1;
      nav.state = atEnd ? "ARRIVED" : "GUIDING";
      if (!atEnd) nav.current_node_id = route.steps[nav.step_index].fromNodeId;
      else nav.current_node_id = route.steps[nav.step_index].toNodeId;
      return { rerouted, ...speakStep(ctx, route, nav.step_index), note: "The instruction is read automatically. Do not repeat it." };
    }

    case "set_preferences": {
      if (input.verbosity === "concise" || input.verbosity === "detailed") nav.prefs.verbosity = input.verbosity;
      if (typeof input.speech_rate === "number") nav.prefs.speech_rate = Math.min(2, Math.max(0.5, input.speech_rate));
      return { prefs: nav.prefs };
    }

    case "report_issue": {
      const note = String(input.note ?? "").slice(0, 500);
      ctx.reports.push({ product_id: nav.product_id, note });
      return { status: "SENT_TO_STAFF", note: "Tell the shopper staff were notified. Inventory is unchanged." };
    }

    case "request_help": {
      nav.state = "NEEDS_HELP";
      return { status: "NEEDS_HELP", help: "Ask any store employee, or go to the help desk if the shopper knows the way. The app cannot call staff in this prototype." };
    }

    default:
      return { error: `Unknown tool ${name}` };
  }
}
