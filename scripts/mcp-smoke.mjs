// Works-gate harness (not shipped): a real MCP client drives `rome mcp` over stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/bin.js", "mcp"], stderr: "pipe" });
const client = new Client({ name: "smoke", version: "0.0.0" });
transport.stderr?.on("data", (d) => console.error("[server stderr]", d.toString()));
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const chain = await client.callTool({ name: "facts_chain", arguments: { chain: "hadrian" } });
const chainObj = JSON.parse(chain.content[0].text);
console.log("facts_chain → chainId:", chainObj.chainId, "programId:", chainObj.romeEvmProgramId);

const recipe = await client.callTool({ name: "cookbook_cpi_recipe", arguments: {} });
console.log("cookbook_cpi-recipe → helper:", JSON.parse(recipe.content[0].text).precompiles.helper);

const gas = await client.callTool({ name: "facts_gas", arguments: { chain: "hadrian" } });
console.log("facts_gas → gasPriceWei:", JSON.parse(gas.content[0].text).gasPriceWei, "(live RPC)");

await client.close();
console.log("MCP-SMOKE: PASS");
