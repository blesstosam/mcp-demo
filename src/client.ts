import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions/index";
import fs from "fs";
import path from "path";

dotenv.config();

interface McpServer {
  type?: "stdio" | "sse";
  command: string;
  args: string[];
  env?: Record<string, any>;
}

interface McpServers {
  mcpServers: {
    [key: string]: McpServer;
  };
}

const mcpServers: McpServers = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "mcp_servers.json"), "utf-8")
);

const apiKey = process.env.apiKey;

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: {
      type: "object";
      properties: Record<
        string,
        {
          type: string;
          description: string;
        }
      >;
    };
    strict?: boolean;
    required?: string[];
  };
}

class MCPClient {
  private mcp: Client;
  private openai: OpenAI;
  private tools: Tool[] = [];

  constructor() {
    this.openai = new OpenAI({
      apiKey,
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    this.mcp = new Client({
      name: "mcp-client-cli",
      version: "1.0.0",
    });
  }

  async connectToServer(serverConfig: McpServer) {
    try {
      // TODO 实现SSE server对接
      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env,
      });

      this.mcp.connect(transport);

      const toolsResult = await this.mcp.listTools();
      // https://github.com/sugarforever/chat-ollama/pull/579/files
      const tools = toolsResult.tools.map((tool) => {
        return {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: true,
            required: [],
          },
        };
      });
      // @ts-expect-error
      this.tools.push(...tools);
      console.log(
        "Connected to server with tools:",
        this.tools.map(({ function: fn }) => fn.name)
      );
    } catch (e) {
      console.log("Failed to connect to MCP server: ", e);
      throw e;
    }
  }

  async processQuery(query: string) {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];

    const response = await this.openai.chat.completions.create({
      model: "qwen2.5-vl-72b-instruct",
      messages,
      max_tokens: 500,
      stop: null,
      tools: this.tools,
    });

    // console.dir(response, { depth: null });

    const finalText: string[] = [];
    const toolResults = [];

    if (response.choices[0].message.tool_calls) {
      const toolCall = response.choices[0].message.tool_calls[0];
      const { name: functionName, arguments: functionArgs } = toolCall.function;

      const result = await this.mcp.callTool({
        name: functionName,
        arguments: JSON.parse(functionArgs),
      });
      toolResults.push(result);
      finalText.push(
        `[Calling tool ${functionName} with args ${JSON.stringify(
          functionArgs
        )}]`
      );

      messages.push({
        role: "tool",
        content: result.content as string,
        tool_call_id: toolCall.id,
      });

      const secondResponse = await this.openai.chat.completions.create({
        model: "qwen2.5-vl-72b-instruct",
        messages,
        max_tokens: 500,
        stop: null,
      });

      finalText.push(secondResponse.choices[0].message.content || "");
    } else {
      finalText.push(response.choices[0].message.content || "");
    }

    return finalText.join("\n");
  }

  async chatLoop() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log("\nMCP Client Started!");
      console.log("Type your queries or 'quit' to exit.");

      while (true) {
        const message = await rl.question("\nQuery: ");
        console.log("Processing query...", message);
        if (message.toLowerCase() === "quit") {
          break;
        }
        const response = await this.processQuery(message);
        console.log("\n" + response);
      }
    } catch (err) {
      console.log("Error in chat loop: ", err);
    } finally {
      rl.close();
    }
  }

  async cleanup() {
    await this.mcp.close();
  }
}

async function main() {
  const mcpClient = new MCPClient();
  try {
    for (const [serverName, serverConfig] of Object.entries(
      mcpServers.mcpServers
    )) {
      console.log("Server name: ", serverName);
      console.log("Server config: ", serverConfig);

      await mcpClient.connectToServer(serverConfig);
    }
    await mcpClient.chatLoop();
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();
