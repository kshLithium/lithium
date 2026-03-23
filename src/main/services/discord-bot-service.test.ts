import { describe, expect, it } from "vitest";
import {
  parseDiscordBotConfig,
  resolveDiscordBotConfig,
  stripBotMention,
  truncateDiscordMessage
} from "./discord-bot-service";

describe("parseDiscordBotConfig", () => {
  it("enables the bot when the Lithium token is present", () => {
    expect(
      parseDiscordBotConfig({
        LITHIUM_DISCORD_BOT_TOKEN: "token-123",
        LITHIUM_DISCORD_WORKSPACE: "/tmp/workspace",
        LITHIUM_DISCORD_ALLOWED_USER_IDS: "u1, u2, u1",
        LITHIUM_DISCORD_ALLOWED_CHANNEL_IDS: "c1, c2"
      })
    ).toEqual({
      enabled: true,
      token: "token-123",
      workspacePath: "/tmp/workspace",
      allowedUserIds: ["u1", "u2"],
      allowedChannelIds: ["c1", "c2"]
    });
  });

  it("falls back to the generic Discord token env var", () => {
    expect(
      parseDiscordBotConfig({
        DISCORD_BOT_TOKEN: "discord-token",
        LITHIUM_WORKSPACE: "/tmp/project"
      })
    ).toEqual({
      enabled: true,
      token: "discord-token",
      workspacePath: "/tmp/project",
      allowedUserIds: [],
      allowedChannelIds: []
    });
  });

  it("stays disabled without a token", () => {
    expect(parseDiscordBotConfig({})).toEqual({
      enabled: false,
      token: "",
      workspacePath: "",
      allowedUserIds: [],
      allowedChannelIds: []
    });
  });
});

describe("resolveDiscordBotConfig", () => {
  it("falls back to env config when settings are still empty", () => {
    expect(
      resolveDiscordBotConfig(
        {
          enabled: false,
          token: "",
          workspacePath: "",
          allowedUserIds: [],
          allowedChannelIds: []
        },
        {
          LITHIUM_DISCORD_BOT_TOKEN: "env-token",
          LITHIUM_DISCORD_ALLOWED_CHANNEL_IDS: "c1"
        }
      )
    ).toEqual({
      enabled: true,
      token: "env-token",
      workspacePath: "",
      allowedUserIds: [],
      allowedChannelIds: ["c1"]
    });
  });

  it("prefers explicit saved settings once the user configures the bot in-app", () => {
    expect(
      resolveDiscordBotConfig(
        {
          enabled: true,
          token: "saved-token",
          workspacePath: "/tmp/workspace",
          allowedUserIds: ["u1"],
          allowedChannelIds: []
        },
        {
          LITHIUM_DISCORD_BOT_TOKEN: "env-token"
        }
      )
    ).toEqual({
      enabled: true,
      token: "saved-token",
      workspacePath: "/tmp/workspace",
      allowedUserIds: ["u1"],
      allowedChannelIds: []
    });
  });
});

describe("stripBotMention", () => {
  it("removes both Discord mention formats and normalizes whitespace", () => {
    expect(stripBotMention("  <@123>  summarize this  ", "123")).toBe("summarize this");
    expect(stripBotMention("<@!123> compare these results", "123")).toBe("compare these results");
  });
});

describe("truncateDiscordMessage", () => {
  it("preserves short content", () => {
    expect(truncateDiscordMessage("short")).toBe("short");
  });

  it("truncates long content with an ellipsis", () => {
    expect(truncateDiscordMessage("abcdefghij", 8)).toBe("abcde...");
  });
});
