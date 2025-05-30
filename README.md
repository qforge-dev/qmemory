# Knowledge Graph Memory Server

A basic implementation of persistent memory using a local knowledge graph. This lets Claude remember information about the user across chats.

## Core Concepts

### Entities

Entities are the primary nodes in the knowledge graph. Each entity has:

- A unique name (identifier)
- An entity type (e.g., "person", "organization", "event")
- A list of observations

Example:

```json
{
  "name": "John_Smith",
  "entityType": "person",
  "observations": ["Speaks fluent Spanish"]
}
```

### Relations

Relations define directed connections between entities. They are always stored in active voice and describe how entities interact or relate to each other.

Example:

```json
{
  "from": "John_Smith",
  "to": "Anthropic",
  "relationType": "works_at"
}
```

### Observations

Observations are discrete pieces of information about an entity. They are:

- Stored as strings
- Attached to specific entities
- Can be added or removed independently
- Should be atomic (one fact per observation)

Example:

```json
{
  "entityName": "John_Smith",
  "observations": [
    "Speaks fluent Spanish",
    "Graduated in 2019",
    "Prefers morning meetings"
  ]
}
```

## API

### Tools

- **create_entities**

  - Create multiple new entities in the knowledge graph
  - Input: `entities` (array of objects)
    - Each object contains:
      - `name` (string): Entity identifier
      - `entityType` (string): Type classification
      - `observations` (string[]): Associated observations
  - Ignores entities with existing names

- **create_relations**

  - Create multiple new relations between entities
  - Input: `relations` (array of objects)
    - Each object contains:
      - `from` (string): Source entity name
      - `to` (string): Target entity name
      - `relationType` (string): Relationship type in active voice
  - Skips duplicate relations

- **add_observations**

  - Add new observations to existing entities
  - Input: `observations` (array of objects)
    - Each object contains:
      - `entityName` (string): Target entity
      - `contents` (string[]): New observations to add
  - Returns added observations per entity
  - Fails if entity doesn't exist

- **delete_entities**

  - Remove entities and their relations
  - Input: `entityNames` (string[])
  - Cascading deletion of associated relations
  - Silent operation if entity doesn't exist

- **delete_observations**

  - Remove specific observations from entities
  - Input: `deletions` (array of objects)
    - Each object contains:
      - `entityName` (string): Target entity
      - `observations` (string[]): Observations to remove
  - Silent operation if observation doesn't exist

- **delete_relations**

  - Remove specific relations from the graph
  - Input: `relations` (array of objects)
    - Each object contains:
      - `from` (string): Source entity name
      - `to` (string): Target entity name
      - `relationType` (string): Relationship type
  - Silent operation if relation doesn't exist

- **read_graph**

  - Read the entire knowledge graph
  - No input required
  - Returns complete graph structure with all entities and relations

- **search_nodes**

  - Search for nodes based on query
  - Input: `query` (string)
  - Searches across:
    - Entity names
    - Entity types
    - Observation content
  - Returns matching entities and their relations

- **open_nodes**
  - Retrieve specific nodes by name
  - Input: `names` (string[])
  - Returns:
    - Requested entities
    - Relations between requested entities
  - Silently skips non-existent nodes

# Usage with Claude Desktop

### Setup

Add this to your claude_desktop_config.json:

#### NPX

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@qforge/qmemory"]
    }
  }
}
```

#### NPX with custom setting

The server can be configured using the following environment variables:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@qforge/qmemory"],
      "env": {
        "DB_FILE_PATH": "/path/to/custom/memory.db",
        "CACHE_DIR": "/path/to/custom/cache",
        "EMBEDDING_MODEL": "BAAI/bge-base-en-v1.5"
      }
    }
  }
}
```

## Environment Variables

The server supports the following environment variables for configuration:

### `DB_FILE_PATH`

- **Description**: Path to the SQLite database file where the knowledge graph data is stored
- **Type**: String (file path)
- **Default**: `memory.db` (in the server script's directory)
- **Behavior**:
  - If an absolute path is provided, it will be used as-is
  - If a relative path or filename is provided, it will be relative to the server script's directory
- **Example**:
  - Absolute: `/home/user/data/my_memory.db`
  - Relative: `custom_memory.db`

### `CACHE_DIR`

- **Description**: Directory path where the embedding model cache files are stored
- **Type**: String (directory path)
- **Default**: `cache` (in the server script's directory)
- **Behavior**:
  - If an absolute path is provided, it will be used as-is
  - If a relative path is provided, it will be relative to the server script's directory
  - The directory will be created automatically if it doesn't exist
- **Example**:
  - Absolute: `/home/user/.cache/qmemory`
  - Relative: `model_cache`

### `EMBEDDING_MODEL`

- **Description**: Specifies which embedding model to use for semantic search functionality
- **Type**: String (model identifier)
- **Default**: `BAAI/bge-base-en-v1.5` (BGEBaseEN)
- **Available Models**: Any model supported by the FastEmbed library, including:
  - `BAAI/bge-base-en-v1.5` (default)
  - `BAAI/bge-small-en-v1.5`
  - `sentence-transformers/all-MiniLM-L6-v2`
  - `sentence-transformers/all-mpnet-base-v2`
  - And others supported by FastEmbed
- **Note**: Different models have different embedding dimensions and performance characteristics. The vector database is configured for 768-dimensional embeddings (BGE models).

### Example Configuration

Here's a complete example with all environment variables configured:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@qforge/qmemory"],
      "env": {
        "DB_FILE_PATH": "/home/user/documents/ai_memory.db",
        "CACHE_DIR": "/home/user/.cache/qmemory_models",
        "EMBEDDING_MODEL": "BAAI/bge-small-en-v1.5"
      }
    }
  }
}
```

# VS Code Installation Instructions

For quick installation, use one of the one-click installation buttons below:

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-NPM-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=memory&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40qforge%2Fqmemory%22%5D%7D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-NPM-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=memory&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40qforge%2Fqmemory%22%5D%7D&quality=insiders)

For manual installation, add the following JSON block to your User Settings (JSON) file in VS Code. You can do this by pressing `Ctrl + Shift + P` and typing `Preferences: Open Settings (JSON)`.

Optionally, you can add it to a file called `.vscode/mcp.json` in your workspace. This will allow you to share the configuration with others.

> Note that the `mcp` key is not needed in the `.vscode/mcp.json` file.

#### NPX

```json
{
  "mcp": {
    "servers": {
      "memory": {
        "command": "npx",
        "args": ["-y", "@qforge/qmemory"]
      }
    }
  }
}
```

### System Prompt

The prompt for utilizing memory depends on the use case. Changing the prompt will help the model determine the frequency and types of memories created.

Here is an example prompt for chat personalization. You could use this prompt in the "Custom Instructions" field of a [Claude.ai Project](https://www.anthropic.com/news/projects).

```
Follow these steps for each interaction:

1. User Identification:
   - You should assume that you are interacting with default_user
   - If you have not identified default_user, proactively try to do so.

2. Memory Retrieval:
   - Always begin your chat by saying only "Remembering..." and retrieve all relevant information from your knowledge graph
   - Always refer to your knowledge graph as your "memory"

3. Memory
   - While conversing with the user, be attentive to any new information that falls into these categories:
     a) Basic Identity (age, gender, location, job title, education level, etc.)
     b) Behaviors (interests, habits, etc.)
     c) Preferences (communication style, preferred language, etc.)
     d) Goals (goals, targets, aspirations, etc.)
     e) Relationships (personal and professional relationships up to 3 degrees of separation)

4. Memory Update:
   - If any new information was gathered during the interaction, update your memory as follows:
     a) Create entities for recurring organizations, people, and significant events
     b) Connect them to the current entities using relations
     b) Store facts about them as observations
```

## Building

```sh
docker build -t mcp/memory -f src/memory/Dockerfile .
```

## Repository

This project is hosted on GitHub. You can find the repository at [https://github.com/qforge/qmemory](https://github.com/qforge/qmemory).

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the [LICENSE](https://github.com/qforge/qmemory/blob/main/LICENSE) file in the project repository.
