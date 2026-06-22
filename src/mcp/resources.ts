import type { NewsletterStorage } from "../storage/NewsletterStorage.js";

export async function listResources(storage: NewsletterStorage) {
  const profiles = await storage.listProfiles();
  const templates = await storage.listTemplates();
  const historyUsers = await storage.listHistoryUsers();
  const categoryUsers = new Set([...profiles.map((profile) => profile.userId), ...historyUsers]);

  return {
    resources: [
      {
        uri: "newsletter://templates",
        name: "Newsletter templates",
        mimeType: "application/json"
      },
      ...templates.map((template) => ({
        uri: `newsletter://templates/${template.templateId}`,
        name: `Newsletter template: ${template.templateId}`,
        mimeType: "application/json"
      })),
      ...profiles.map((profile) => ({
        uri: `newsletter://profiles/${profile.userId}`,
        name: `Newsletter profile: ${profile.userId}`,
        mimeType: "application/json"
      })),
      ...[...categoryUsers].map((userId) => ({
        uri: `newsletter://categories/${userId}`,
        name: `Interest tag settings: ${userId}`,
        mimeType: "application/json"
      })),
      ...historyUsers.map((userId) => ({
        uri: `newsletter://history/${userId}`,
        name: `Newsletter history: ${userId}`,
        mimeType: "application/json"
      }))
    ]
  };
}

export function listResourceTemplates() {
  return {
    resourceTemplates: [
      {
        uriTemplate: "newsletter://profiles/{userId}",
        name: "User newsletter profile",
        mimeType: "application/json"
      },
      {
        uriTemplate: "newsletter://categories/{userId}",
        name: "User dynamic interest tag settings",
        mimeType: "application/json"
      },
      {
        uriTemplate: "newsletter://history/{userId}",
        name: "User newsletter generation history",
        mimeType: "application/json"
      },
      {
        uriTemplate: "newsletter://templates/{templateId}",
        name: "Newsletter template",
        mimeType: "application/json"
      }
    ]
  };
}

export async function readResource(storage: NewsletterStorage, uri: string) {
  const [kind, id] = parseNewsletterUri(uri);

  if (kind === "templates" && !id) {
    return resourceContents(uri, { templates: await storage.listTemplates() });
  }

  if (kind === "templates" && id) {
    const template = await storage.getTemplate(id);
    if (!template) {
      throw new Error(`Template not found: ${id}`);
    }
    return resourceContents(uri, { template });
  }

  if (kind === "profiles" && id) {
    const profile = await storage.getProfile(id);
    if (!profile) {
      throw new Error(`Profile not found: ${id}`);
    }
    return resourceContents(uri, { profile });
  }

  if (kind === "categories" && id) {
    return resourceContents(uri, {
      userId: id,
      settings: await storage.listUserCategorySettings(id)
    });
  }

  if (kind === "history" && id) {
    return resourceContents(uri, {
      userId: id,
      history: await storage.listHistory(id)
    });
  }

  throw new Error(`Unsupported resource URI: ${uri}`);
}

function resourceContents(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function parseNewsletterUri(uri: string): [string, string | undefined] {
  const prefix = "newsletter://";
  if (!uri.startsWith(prefix)) {
    throw new Error(`Invalid newsletter URI: ${uri}`);
  }
  const [kind, ...rest] = uri.slice(prefix.length).split("/");
  return [kind, rest.length > 0 ? decodeURIComponent(rest.join("/")) : undefined];
}
