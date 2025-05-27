#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { FlagEmbedding, EmbeddingModel } from "fastembed";
import path from "path";
import { fileURLToPath } from "url";

// Define database file path using environment variable with fallback
const defaultDbPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "memory.db"
);

// If DB_FILE_PATH is just a filename, put it in the same directory as the script
const DB_FILE_PATH = process.env.DB_FILE_PATH
  ? path.isAbsolute(process.env.DB_FILE_PATH)
    ? process.env.DB_FILE_PATH
    : path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        process.env.DB_FILE_PATH
      )
  : defaultDbPath;

// We are storing our memory using entities, relations, and observations in a graph structure
interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

interface Relation {
  from: string;
  to: string;
  relationType: string;
}

interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph
class KnowledgeGraphManager {
  private db: Database.Database;
  private embeddingModel: FlagEmbedding | null = null;

  private constructor() {
    this.db = new Database(DB_FILE_PATH);
    sqliteVec.load(this.db);
    this.initializeDatabase();
  }

  public static async create(): Promise<KnowledgeGraphManager> {
    const manager = new KnowledgeGraphManager();
    manager.embeddingModel = await FlagEmbedding.init({
      model: EmbeddingModel.BGEBaseEN,
    });
    return manager;
  }

  private initializeDatabase(): void {
    // Create tables if they don't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        entityType TEXT NOT NULL,
        observations TEXT DEFAULT '',
        embedding BLOB 
      );

      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity TEXT NOT NULL,
        to_entity TEXT NOT NULL,
        relationType TEXT NOT NULL,
        UNIQUE(from_entity, to_entity, relationType)
      );

      -- Create virtual table for vector search if it doesn't exist
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(
        entity_id INTEGER PRIMARY KEY,
        embedding FLOAT[768] -- Adjusted for BGEBaseEN (768 dimensions)
      );
    `);
  }

  private async generateEmbedding(text: string): Promise<Float32Array> {
    if (!this.embeddingModel) {
      throw new Error(
        "Embedding model not initialized. Call KnowledgeGraphManager.create()"
      );
    }
    // fastembed expects an array of documents
    const embeddingsGenerator = this.embeddingModel.embed([text]);
    let firstEmbeddingArray: number[] | null = null;

    for await (const batch of embeddingsGenerator) {
      if (batch && batch.length > 0 && batch[0] && batch[0].length > 0) {
        firstEmbeddingArray = batch[0];
        break; // We only need the first embedding for a single text input
      }
    }

    if (!firstEmbeddingArray) {
      throw new Error("Failed to generate embedding.");
    }
    return new Float32Array(firstEmbeddingArray);
  }

  private async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const entities = this.db
        .prepare("SELECT * FROM entities")
        .all() as Array<{
        name: string;
        entityType: string;
        observations: string;
      }>;

      const relations = this.db
        .prepare("SELECT * FROM relations")
        .all() as Array<{
        from_entity: string;
        to_entity: string;
        relationType: string;
      }>;

      return {
        entities: entities.map((e) => ({
          name: e.name,
          entityType: e.entityType,
          observations: e.observations ? e.observations.split("|||") : [],
        })),
        relations: relations.map((r) => ({
          from: r.from_entity,
          to: r.to_entity,
          relationType: r.relationType,
        })),
      };
    } catch (error) {
      // Return empty graph if there's an error
      return { entities: [], relations: [] };
    }
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    const insertEntity = this.db.prepare(`
      INSERT OR IGNORE INTO entities (name, entityType, observations, embedding) 
      VALUES (?, ?, ?, ?)
    `);
    const insertVecEntity = this.db.prepare(`
      INSERT INTO entities_vec (entity_id, embedding) VALUES (?, ?)
    `);

    const newEntities: Entity[] = [];

    for (const entity of entities) {
      // Generate a placeholder embedding (null or a zero vector) for now
      // The actual embedding will be generated and stored in the background
      const placeholderEmbeddingBuffer = new Float32Array(768).buffer; // Or null if your schema allows

      const result = insertEntity.run(
        entity.name,
        entity.entityType,
        entity.observations.join("|||"),
        placeholderEmbeddingBuffer // Store placeholder
      );

      if (result.changes > 0) {
        newEntities.push(entity);
        const lastInsertRowid = result.lastInsertRowid;

        // Run embedding generation and storage in the background
        (async () => {
          try {
            const combinedText = `${entity.name} ${entity.observations.join(
              " "
            )}`;
            const embedding = await this.generateEmbedding(combinedText);

            // Update the entity with the actual embedding
            this.db
              .prepare("UPDATE entities SET embedding = ? WHERE id = ?")
              .run(embedding.buffer, lastInsertRowid);
            // Insert into the vector table
            insertVecEntity.run(lastInsertRowid, embedding.buffer);
          } catch (error) {
            console.error(
              `Error generating/storing embedding for entity ${entity.name}:`,
              error
            );
          }
        })();
      }
    }

    return newEntities;
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const insertRelation = this.db.prepare(`
      INSERT OR IGNORE INTO relations (from_entity, to_entity, relationType) 
      VALUES (?, ?, ?)
    `);

    const newRelations: Relation[] = [];

    for (const relation of relations) {
      const result = insertRelation.run(
        relation.from,
        relation.to,
        relation.relationType
      );

      if (result.changes > 0) {
        newRelations.push(relation);
      }
    }

    return newRelations;
  }

  async addObservations(
    observations: { entityName: string; contents: string[] }[]
  ): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const getEntity = this.db.prepare(
      "SELECT id, observations FROM entities WHERE name = ?"
    );
    const updateEntityObservations = this.db.prepare(
      // Renamed to avoid confusion
      "UPDATE entities SET observations = ? WHERE name = ?"
    );
    const updateEntityEmbedding = this.db.prepare(
      // For updating embedding separately
      "UPDATE entities SET embedding = ? WHERE id = ?"
    );
    const updateVecEntity = this.db.prepare(`
      UPDATE entities_vec SET embedding = ? WHERE entity_id = ?
    `);

    const results = await Promise.all(
      observations.map(async (o) => {
        const entityRow = getEntity.get(o.entityName) as
          | { id: number; observations: string }
          | undefined;

        if (!entityRow) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }

        const existingObservations = entityRow.observations
          ? entityRow.observations.split("|||")
          : [];
        const newObservations = o.contents.filter(
          (content) => !existingObservations.includes(content)
        );

        let addedObservationsActually: string[] = [];
        if (newObservations.length > 0) {
          const allObservations = [...existingObservations, ...newObservations];
          updateEntityObservations.run(
            allObservations.join("|||"),
            o.entityName
          );
          addedObservationsActually = newObservations;

          // Run embedding update in the background
          (async () => {
            try {
              // Fetch the entity name again, as o.entityName might not be in scope if entity is renamed later (though not current capability)
              const currentEntity = this.db
                .prepare("SELECT name FROM entities WHERE id = ?")
                .get(entityRow.id) as { name: string };
              if (!currentEntity) {
                console.error(
                  `Entity with id ${entityRow.id} not found for background embedding update.`
                );
                return;
              }
              const combinedText = `${
                currentEntity.name
              } ${allObservations.join(" ")}`;
              const embedding = await this.generateEmbedding(combinedText);
              updateEntityEmbedding.run(embedding.buffer, entityRow.id);
              updateVecEntity.run(embedding.buffer, entityRow.id);
            } catch (error) {
              console.error(
                `Error updating embedding for entity ${o.entityName}:`,
                error
              );
            }
          })();
        }

        return {
          entityName: o.entityName,
          addedObservations: addedObservationsActually,
        };
      })
    );

    return results;
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    const getEntityId = this.db.prepare(
      "SELECT id FROM entities WHERE name = ?"
    );
    const deleteEntity = this.db.prepare("DELETE FROM entities WHERE name = ?");
    const deleteVecEntity = this.db.prepare(
      "DELETE FROM entities_vec WHERE entity_id = ?"
    );
    const deleteRelations = this.db.prepare(
      "DELETE FROM relations WHERE from_entity = ? OR to_entity = ?"
    );

    for (const entityName of entityNames) {
      const entityRow = getEntityId.get(entityName) as
        | { id: number }
        | undefined;
      if (entityRow) {
        deleteVecEntity.run(entityRow.id);
      }
      deleteEntity.run(entityName);
      deleteRelations.run(entityName, entityName);
    }
  }

  async deleteObservations(
    deletions: { entityName: string; observations: string[] }[]
  ): Promise<void> {
    const getEntity = this.db.prepare(
      "SELECT observations FROM entities WHERE name = ?"
    );
    const updateEntity = this.db.prepare(
      "UPDATE entities SET observations = ? WHERE name = ?"
    );

    deletions.forEach((d) => {
      const entity = getEntity.get(d.entityName) as
        | { observations: string }
        | undefined;

      if (entity) {
        const existingObservations = entity.observations
          ? entity.observations.split("|||")
          : [];
        const filteredObservations = existingObservations.filter(
          (o) => !d.observations.includes(o)
        );
        updateEntity.run(filteredObservations.join("|||"), d.entityName);
      }
    });
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    const deleteRelation = this.db.prepare(`
      DELETE FROM relations 
      WHERE from_entity = ? AND to_entity = ? AND relationType = ?
    `);

    for (const relation of relations) {
      deleteRelation.run(relation.from, relation.to, relation.relationType);
    }
  }

  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  async searchNodes(query: string, topK: number = 5): Promise<KnowledgeGraph> {
    const queryEmbedding = await this.generateEmbedding(query);

    const similarEntityIds = this.db
      .prepare(
        `
        SELECT entity_id, distance 
        FROM entities_vec 
        WHERE vec_search(embedding, ?) 
        ORDER BY distance 
        LIMIT ?
      `
      )
      .all(queryEmbedding.buffer, topK) as Array<{
      entity_id: number;
      distance: number;
    }>;

    if (similarEntityIds.length === 0) {
      return { entities: [], relations: [] };
    }

    const entityIds = similarEntityIds.map((item) => item.entity_id);
    const placeholders = entityIds.map(() => "?").join(",");

    const entities = this.db
      .prepare(
        `
      SELECT id, name, entityType, observations FROM entities 
      WHERE id IN (${placeholders})
    `
      )
      .all(...entityIds) as Array<{
      id: number;
      name: string;
      entityType: string;
      observations: string;
    }>;

    const entityNames = entities.map((e) => e.name);
    let relations: Array<{
      from_entity: string;
      to_entity: string;
      relationType: string;
    }> = [];

    if (entityNames.length > 0) {
      const placeholders = entityNames.map(() => "?").join(",");
      relations = this.db
        .prepare(
          `
        SELECT * FROM relations 
        WHERE from_entity IN (${placeholders}) 
          AND to_entity IN (${placeholders})
      `
        )
        .all(...entityNames, ...entityNames) as Array<{
        from_entity: string;
        to_entity: string;
        relationType: string;
      }>;
    }

    return {
      entities: entities.map((e) => ({
        name: e.name,
        entityType: e.entityType,
        observations: e.observations ? e.observations.split("|||") : [],
      })),
      relations: relations.map((r) => ({
        from: r.from_entity,
        to: r.to_entity,
        relationType: r.relationType,
      })),
    };
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    if (names.length === 0) {
      return { entities: [], relations: [] };
    }

    const placeholders = names.map(() => "?").join(",");

    const entities = this.db
      .prepare(
        `
      SELECT * FROM entities WHERE name IN (${placeholders})
    `
      )
      .all(...names) as Array<{
      name: string;
      entityType: string;
      observations: string;
    }>;

    const relations = this.db
      .prepare(
        `
      SELECT * FROM relations 
      WHERE from_entity IN (${placeholders}) 
        AND to_entity IN (${placeholders})
    `
      )
      .all(...names, ...names) as Array<{
      from_entity: string;
      to_entity: string;
      relationType: string;
    }>;

    return {
      entities: entities.map((e) => ({
        name: e.name,
        entityType: e.entityType,
        observations: e.observations ? e.observations.split("|||") : [],
      })),
      relations: relations.map((r) => ({
        from: r.from_entity,
        to: r.to_entity,
        relationType: r.relationType,
      })),
    };
  }
}

let knowledgeGraphManager: KnowledgeGraphManager;
async function initializeManager() {
  knowledgeGraphManager = await KnowledgeGraphManager.create();
}

// The server instance and tools exposed to Claude
const server = new Server(
  {
    name: "memory-server",
    version: "0.6.3",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_entities",
        description: "Create multiple new entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            entities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "The name of the entity",
                  },
                  entityType: {
                    type: "string",
                    description: "The type of the entity",
                  },
                  observations: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "An array of observation contents associated with the entity",
                  },
                },
                required: ["name", "entityType", "observations"],
              },
            },
          },
          required: ["entities"],
        },
      },
      {
        name: "create_relations",
        description:
          "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
        inputSchema: {
          type: "object",
          properties: {
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: {
                    type: "string",
                    description:
                      "The name of the entity where the relation starts",
                  },
                  to: {
                    type: "string",
                    description:
                      "The name of the entity where the relation ends",
                  },
                  relationType: {
                    type: "string",
                    description: "The type of the relation",
                  },
                },
                required: ["from", "to", "relationType"],
              },
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "add_observations",
        description:
          "Add new observations to existing entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            observations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: {
                    type: "string",
                    description:
                      "The name of the entity to add the observations to",
                  },
                  contents: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observation contents to add",
                  },
                },
                required: ["entityName", "contents"],
              },
            },
          },
          required: ["observations"],
        },
      },
      {
        name: "delete_entities",
        description:
          "Delete multiple entities and their associated relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            entityNames: {
              type: "array",
              items: { type: "string" },
              description: "An array of entity names to delete",
            },
          },
          required: ["entityNames"],
        },
      },
      {
        name: "delete_observations",
        description:
          "Delete specific observations from entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            deletions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: {
                    type: "string",
                    description:
                      "The name of the entity containing the observations",
                  },
                  observations: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observations to delete",
                  },
                },
                required: ["entityName", "observations"],
              },
            },
          },
          required: ["deletions"],
        },
      },
      {
        name: "delete_relations",
        description: "Delete multiple relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: {
                    type: "string",
                    description:
                      "The name of the entity where the relation starts",
                  },
                  to: {
                    type: "string",
                    description:
                      "The name of the entity where the relation ends",
                  },
                  relationType: {
                    type: "string",
                    description: "The type of the relation",
                  },
                },
                required: ["from", "to", "relationType"],
              },
              description: "An array of relations to delete",
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "read_graph",
        description: "Read the entire knowledge graph",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "search_nodes",
        description: "Search for nodes in the knowledge graph based on a query",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "The search query to match against entity names, types, and observation content",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "open_nodes",
        description:
          "Open specific nodes in the knowledge graph by their names",
        inputSchema: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "An array of entity names to retrieve",
            },
          },
          required: ["names"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error(`No arguments provided for tool: ${name}`);
  }

  switch (name) {
    case "create_entities":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.createEntities(
                args.entities as Entity[]
              ),
              null,
              2
            ),
          },
        ],
      };
    case "create_relations":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.createRelations(
                args.relations as Relation[]
              ),
              null,
              2
            ),
          },
        ],
      };
    case "add_observations":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.addObservations(
                args.observations as {
                  entityName: string;
                  contents: string[];
                }[]
              ),
              null,
              2
            ),
          },
        ],
      };
    case "delete_entities":
      await knowledgeGraphManager.deleteEntities(args.entityNames as string[]);
      return {
        content: [{ type: "text", text: "Entities deleted successfully" }],
      };
    case "delete_observations":
      await knowledgeGraphManager.deleteObservations(
        args.deletions as { entityName: string; observations: string[] }[]
      );
      return {
        content: [{ type: "text", text: "Observations deleted successfully" }],
      };
    case "delete_relations":
      await knowledgeGraphManager.deleteRelations(args.relations as Relation[]);
      return {
        content: [{ type: "text", text: "Relations deleted successfully" }],
      };
    case "read_graph":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.readGraph(),
              null,
              2
            ),
          },
        ],
      };
    case "search_nodes":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.searchNodes(args.query as string),
              null,
              2
            ),
          },
        ],
      };
    case "open_nodes":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.openNodes(args.names as string[]),
              null,
              2
            ),
          },
        ],
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

// Initialize the manager before starting the main application logic
initializeManager()
  .then(() => {
    main().catch((error) => {
      console.error("Fatal error in main():", error);
      process.exit(1);
    });
  })
  .catch((error) => {
    console.error("Fatal error initializing KnowledgeGraphManager:", error);
    process.exit(1);
  });
