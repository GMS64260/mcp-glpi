#!/usr/bin/env node

/**
 * MCP Server for GLPI v2.0
 * Full-featured IT Service Management integration with Claude
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { GlpiClient, GlpiConfig } from './glpi-client.js';

// Status mappings
const TICKET_STATUS: Record<number, string> = {
  1: 'New',
  2: 'Processing (assigned)',
  3: 'Processing (planned)',
  4: 'Pending',
  5: 'Solved',
  6: 'Closed',
};

const TICKET_URGENCY: Record<number, string> = {
  1: 'Very low',
  2: 'Low',
  3: 'Medium',
  4: 'High',
  5: 'Very high',
};

const PROBLEM_STATUS: Record<number, string> = {
  1: 'New',
  2: 'Accepted',
  3: 'Planned',
  4: 'Pending',
  5: 'Solved',
  6: 'Closed',
};

const CHANGE_STATUS: Record<number, string> = {
  1: 'New',
  2: 'Evaluation',
  3: 'Approval',
  4: 'Accepted',
  5: 'Pending',
  6: 'Test',
  7: 'Qualification',
  8: 'Applied',
  9: 'Review',
  10: 'Closed',
  11: 'Refused',
  12: 'Canceled',
};

// Get configuration from environment variables
function getConfig(): GlpiConfig {
  const url = process.env.GLPI_URL;
  if (!url) {
    throw new Error('GLPI_URL environment variable is required');
  }

  return {
    url,
    appToken: process.env.GLPI_APP_TOKEN,
    userToken: process.env.GLPI_USER_TOKEN,
    username: process.env.GLPI_USERNAME,
    password: process.env.GLPI_PASSWORD,
  };
}

// Initialize the MCP server
const server = new Server(
  {
    name: 'mcp-glpi',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

let glpiClient: GlpiClient;

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // ==================== TICKET TOOLS ====================
      {
        name: 'glpi_list_tickets',
        description: 'List tickets from GLPI with optional filters',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number of tickets to return (default: 50)' },
            status: { type: 'number', description: 'Filter by status (1=New, 2=Processing assigned, 3=Processing planned, 4=Pending, 5=Solved, 6=Closed)' },
            order: { type: 'string', enum: ['ASC', 'DESC'], description: 'Sort order (default: DESC)' },
          },
        },
      },
      {
        name: 'glpi_get_ticket',
        description: 'Get detailed information about a specific ticket including followups and tasks',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The ticket ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_create_ticket',
        description: 'Create a new ticket in GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Ticket title/subject' },
            content: { type: 'string', description: 'Ticket description/content' },
            urgency: { type: 'number', description: 'Urgency level (1-5, default: 3)' },
            category_id: { type: 'number', description: 'Category ID for the ticket' },
            user_id_assign: { type: 'number', description: 'User ID to assign the ticket to' },
            group_id_assign: { type: 'number', description: 'Group ID to assign the ticket to' },
            type: { type: 'number', description: 'Ticket type (1=Incident, 2=Request)' },
          },
          required: ['name', 'content'],
        },
      },
      {
        name: 'glpi_update_ticket',
        description: 'Update an existing ticket',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The ticket ID to update' },
            name: { type: 'string', description: 'New ticket title' },
            content: { type: 'string', description: 'New ticket content' },
            status: { type: 'number', description: 'New status (1-6)' },
            urgency: { type: 'number', description: 'New urgency (1-5)' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_delete_ticket',
        description: 'Delete a ticket (move to trash or permanently delete)',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The ticket ID to delete' },
            force: { type: 'boolean', description: 'Permanently delete (true) or move to trash (false, default)' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_add_followup',
        description: 'Add a followup/comment to a ticket',
        inputSchema: {
          type: 'object',
          properties: {
            ticket_id: { type: 'number', description: 'The ticket ID' },
            content: { type: 'string', description: 'Followup content' },
            is_private: { type: 'boolean', description: 'Whether the followup is private (default: false)' },
          },
          required: ['ticket_id', 'content'],
        },
      },
      {
        name: 'glpi_add_task',
        description: 'Add a task to a ticket',
        inputSchema: {
          type: 'object',
          properties: {
            ticket_id: { type: 'number', description: 'The ticket ID' },
            content: { type: 'string', description: 'Task description' },
            actiontime: { type: 'number', description: 'Time spent in seconds' },
            is_private: { type: 'boolean', description: 'Whether the task is private' },
            state: { type: 'number', description: 'Task state (0=Information, 1=To do, 2=Done)' },
            users_id_tech: { type: 'number', description: 'Technician user ID' },
          },
          required: ['ticket_id', 'content'],
        },
      },
      {
        name: 'glpi_add_solution',
        description: 'Add a solution to close a ticket',
        inputSchema: {
          type: 'object',
          properties: {
            ticket_id: { type: 'number', description: 'The ticket ID' },
            content: { type: 'string', description: 'Solution description' },
            solutiontypes_id: { type: 'number', description: 'Solution type ID' },
          },
          required: ['ticket_id', 'content'],
        },
      },
      {
        name: 'glpi_assign_ticket',
        description: 'Assign a ticket to a user or group',
        inputSchema: {
          type: 'object',
          properties: {
            ticket_id: { type: 'number', description: 'The ticket ID' },
            user_id: { type: 'number', description: 'User ID to assign' },
            type: { type: 'number', description: 'Actor type (1=Requester, 2=Assigned, 3=Observer)' },
          },
          required: ['ticket_id', 'user_id'],
        },
      },
      {
        name: 'glpi_get_ticket_tasks',
        description: 'Get all tasks for a ticket',
        inputSchema: {
          type: 'object',
          properties: {
            ticket_id: { type: 'number', description: 'The ticket ID' },
          },
          required: ['ticket_id'],
        },
      },
      {
        name: 'glpi_get_ticket_followups',
        description: 'Get all followups/comments for a ticket',
        inputSchema: {
          type: 'object',
          properties: {
            ticket_id: { type: 'number', description: 'The ticket ID' },
          },
          required: ['ticket_id'],
        },
      },
      {
        name: 'glpi_get_ticket_solutions',
        description: 'Get all solutions for a ticket',
        inputSchema: {
          type: 'object',
          properties: {
            ticket_id: { type: 'number', description: 'The ticket ID' },
          },
          required: ['ticket_id'],
        },
      },

      // ==================== PROBLEM TOOLS ====================
      {
        name: 'glpi_list_problems',
        description: 'List problems from GLPI (ITIL Problem Management)',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number of problems to return (default: 50)' },
            order: { type: 'string', enum: ['ASC', 'DESC'], description: 'Sort order' },
          },
        },
      },
      {
        name: 'glpi_get_problem',
        description: 'Get detailed information about a specific problem',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The problem ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_create_problem',
        description: 'Create a new problem in GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Problem title' },
            content: { type: 'string', description: 'Problem description' },
            urgency: { type: 'number', description: 'Urgency (1-5)' },
            impact: { type: 'number', description: 'Impact (1-5)' },
            priority: { type: 'number', description: 'Priority (1-6)' },
            category_id: { type: 'number', description: 'Category ID' },
          },
          required: ['name', 'content'],
        },
      },
      {
        name: 'glpi_update_problem',
        description: 'Update an existing problem',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The problem ID' },
            name: { type: 'string', description: 'New title' },
            content: { type: 'string', description: 'New content' },
            status: { type: 'number', description: 'New status' },
            urgency: { type: 'number', description: 'New urgency' },
          },
          required: ['id'],
        },
      },

      // ==================== CHANGE TOOLS ====================
      {
        name: 'glpi_list_changes',
        description: 'List changes from GLPI (ITIL Change Management)',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number of changes to return (default: 50)' },
            order: { type: 'string', enum: ['ASC', 'DESC'], description: 'Sort order' },
          },
        },
      },
      {
        name: 'glpi_get_change',
        description: 'Get detailed information about a specific change',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The change ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_create_change',
        description: 'Create a new change request in GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Change title' },
            content: { type: 'string', description: 'Change description' },
            urgency: { type: 'number', description: 'Urgency (1-5)' },
            impact: { type: 'number', description: 'Impact (1-5)' },
            priority: { type: 'number', description: 'Priority (1-6)' },
            category_id: { type: 'number', description: 'Category ID' },
          },
          required: ['name', 'content'],
        },
      },
      {
        name: 'glpi_update_change',
        description: 'Update an existing change',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The change ID' },
            name: { type: 'string', description: 'New title' },
            content: { type: 'string', description: 'New content' },
            status: { type: 'number', description: 'New status' },
          },
          required: ['id'],
        },
      },

      // ==================== COMPUTER/ASSET TOOLS ====================
      {
        name: 'glpi_list_computers',
        description: 'List computers/workstations from GLPI inventory',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number of computers to return (default: 50)' },
            include_deleted: { type: 'boolean', description: 'Include deleted computers (default: false)' },
          },
        },
      },
      {
        name: 'glpi_get_computer',
        description: 'Get detailed information about a specific computer including software and connections',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The computer ID' },
            with_softwares: { type: 'boolean', description: 'Include installed software' },
            with_connections: { type: 'boolean', description: 'Include connected items' },
            with_networkports: { type: 'boolean', description: 'Include network ports' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_create_computer',
        description: 'Create a new computer in GLPI inventory',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Computer name' },
            serial: { type: 'string', description: 'Serial number' },
            otherserial: { type: 'string', description: 'Inventory number' },
            contact: { type: 'string', description: 'Contact person' },
            comment: { type: 'string', description: 'Comments' },
            locations_id: { type: 'number', description: 'Location ID' },
            states_id: { type: 'number', description: 'State ID' },
            computertypes_id: { type: 'number', description: 'Computer type ID' },
            manufacturers_id: { type: 'number', description: 'Manufacturer ID' },
          },
          required: ['name'],
        },
      },
      {
        name: 'glpi_update_computer',
        description: 'Update an existing computer',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The computer ID' },
            name: { type: 'string', description: 'New name' },
            serial: { type: 'string', description: 'New serial number' },
            comment: { type: 'string', description: 'New comment' },
            locations_id: { type: 'number', description: 'New location ID' },
            states_id: { type: 'number', description: 'New state ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_delete_computer',
        description: 'Delete a computer from inventory',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The computer ID' },
            force: { type: 'boolean', description: 'Permanently delete (default: false, moves to trash)' },
          },
          required: ['id'],
        },
      },

      // ==================== SOFTWARE TOOLS ====================
      {
        name: 'glpi_list_softwares',
        description: 'List software from GLPI inventory',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number of software to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_software',
        description: 'Get detailed information about a specific software',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The software ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_create_software',
        description: 'Create a new software entry',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Software name' },
            comment: { type: 'string', description: 'Comments' },
            manufacturers_id: { type: 'number', description: 'Manufacturer ID' },
            softwarecategories_id: { type: 'number', description: 'Software category ID' },
          },
          required: ['name'],
        },
      },

      // ==================== NETWORK EQUIPMENT TOOLS ====================
      {
        name: 'glpi_list_network_equipments',
        description: 'List network equipment (switches, routers, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_network_equipment',
        description: 'Get detailed information about a network equipment',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The equipment ID' },
            with_networkports: { type: 'boolean', description: 'Include network ports' },
          },
          required: ['id'],
        },
      },

      // ==================== PRINTER TOOLS ====================
      {
        name: 'glpi_list_printers',
        description: 'List printers from GLPI inventory',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_printer',
        description: 'Get detailed information about a printer',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The printer ID' },
          },
          required: ['id'],
        },
      },

      // ==================== MONITOR TOOLS ====================
      {
        name: 'glpi_list_monitors',
        description: 'List monitors from GLPI inventory',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_monitor',
        description: 'Get detailed information about a monitor',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The monitor ID' },
          },
          required: ['id'],
        },
      },

      // ==================== PHONE TOOLS ====================
      {
        name: 'glpi_list_phones',
        description: 'List phones from GLPI inventory',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_phone',
        description: 'Get detailed information about a phone',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The phone ID' },
          },
          required: ['id'],
        },
      },

      // ==================== KNOWLEDGE BASE TOOLS ====================
      {
        name: 'glpi_list_knowbase',
        description: 'List knowledge base articles',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_knowbase_item',
        description: 'Get a specific knowledge base article',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The article ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_search_knowbase',
        description: 'Search knowledge base articles',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
      },
      {
        name: 'glpi_create_knowbase_item',
        description: 'Create a new knowledge base article',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Article title' },
            answer: { type: 'string', description: 'Article content (HTML supported)' },
            is_faq: { type: 'boolean', description: 'Add to FAQ (default: false)' },
            knowbaseitemcategories_id: { type: 'number', description: 'Category ID' },
          },
          required: ['name', 'answer'],
        },
      },

      // ==================== CONTRACT TOOLS ====================
      {
        name: 'glpi_list_contracts',
        description: 'List contracts from GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_contract',
        description: 'Get detailed information about a contract',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The contract ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_create_contract',
        description: 'Create a new contract',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Contract name' },
            num: { type: 'string', description: 'Contract number' },
            begin_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
            duration: { type: 'number', description: 'Duration in months' },
            notice: { type: 'number', description: 'Notice period in months' },
            comment: { type: 'string', description: 'Comments' },
          },
          required: ['name'],
        },
      },

      // ==================== SUPPLIER TOOLS ====================
      {
        name: 'glpi_list_suppliers',
        description: 'List suppliers from GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_supplier',
        description: 'Get detailed information about a supplier',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The supplier ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_create_supplier',
        description: 'Create a new supplier',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Supplier name' },
            address: { type: 'string', description: 'Address' },
            postcode: { type: 'string', description: 'Postal code' },
            town: { type: 'string', description: 'City' },
            country: { type: 'string', description: 'Country' },
            website: { type: 'string', description: 'Website URL' },
            phonenumber: { type: 'string', description: 'Phone number' },
            email: { type: 'string', description: 'Email address' },
          },
          required: ['name'],
        },
      },

      // ==================== LOCATION TOOLS ====================
      {
        name: 'glpi_list_locations',
        description: 'List locations from GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_location',
        description: 'Get detailed information about a location',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The location ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_create_location',
        description: 'Create a new location',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Location name' },
            address: { type: 'string', description: 'Address' },
            postcode: { type: 'string', description: 'Postal code' },
            town: { type: 'string', description: 'City' },
            building: { type: 'string', description: 'Building' },
            room: { type: 'string', description: 'Room' },
            locations_id: { type: 'number', description: 'Parent location ID' },
          },
          required: ['name'],
        },
      },

      // ==================== PROJECT TOOLS ====================
      {
        name: 'glpi_list_projects',
        description: 'List projects from GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_project',
        description: 'Get detailed information about a project',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The project ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_create_project',
        description: 'Create a new project',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Project name' },
            code: { type: 'string', description: 'Project code' },
            content: { type: 'string', description: 'Project description' },
            priority: { type: 'number', description: 'Priority (1-6)' },
            plan_start_date: { type: 'string', description: 'Planned start date (YYYY-MM-DD)' },
            plan_end_date: { type: 'string', description: 'Planned end date (YYYY-MM-DD)' },
            users_id: { type: 'number', description: 'Manager user ID' },
            groups_id: { type: 'number', description: 'Manager group ID' },
          },
          required: ['name'],
        },
      },
      {
        name: 'glpi_update_project',
        description: 'Update an existing project',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The project ID' },
            name: { type: 'string', description: 'New name' },
            content: { type: 'string', description: 'New description' },
            percent_done: { type: 'number', description: 'Completion percentage (0-100)' },
            real_start_date: { type: 'string', description: 'Actual start date' },
            real_end_date: { type: 'string', description: 'Actual end date' },
          },
          required: ['id'],
        },
      },

      // ==================== USER TOOLS ====================
      {
        name: 'glpi_list_users',
        description: 'List users from GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number of users to return (default: 50)' },
            active_only: { type: 'boolean', description: 'Only return active users (default: true)' },
          },
        },
      },
      {
        name: 'glpi_get_user',
        description: 'Get detailed information about a specific user',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The user ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_search_user',
        description: 'Search for a user by name',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Username to search for' },
          },
          required: ['name'],
        },
      },
      {
        name: 'glpi_create_user',
        description: 'Create a new user',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Username (login)' },
            password: { type: 'string', description: 'Password' },
            realname: { type: 'string', description: 'Last name' },
            firstname: { type: 'string', description: 'First name' },
            email: { type: 'string', description: 'Email address' },
            phone: { type: 'string', description: 'Phone number' },
            profiles_id: { type: 'number', description: 'Profile ID' },
          },
          required: ['name'],
        },
      },

      // ==================== GROUP TOOLS ====================
      {
        name: 'glpi_list_groups',
        description: 'List groups from GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number of groups to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_group',
        description: 'Get detailed information about a specific group',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The group ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'glpi_create_group',
        description: 'Create a new group',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Group name' },
            comment: { type: 'string', description: 'Comments' },
            is_requester: { type: 'boolean', description: 'Can be requester' },
            is_assign: { type: 'boolean', description: 'Can be assigned to tickets' },
          },
          required: ['name'],
        },
      },
      {
        name: 'glpi_add_user_to_group',
        description: 'Add a user to a group',
        inputSchema: {
          type: 'object',
          properties: {
            user_id: { type: 'number', description: 'User ID' },
            group_id: { type: 'number', description: 'Group ID' },
            is_manager: { type: 'boolean', description: 'Set as group manager' },
          },
          required: ['user_id', 'group_id'],
        },
      },

      // ==================== CATEGORY TOOLS ====================
      {
        name: 'glpi_list_categories',
        description: 'List ticket categories from GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number of categories to return (default: 50)' },
          },
        },
      },

      // ==================== ENTITY TOOLS ====================
      {
        name: 'glpi_list_entities',
        description: 'List entities from GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_entity',
        description: 'Get detailed information about an entity',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The entity ID' },
          },
          required: ['id'],
        },
      },

      // ==================== DOCUMENT TOOLS ====================
      {
        name: 'glpi_list_documents',
        description: 'List documents from GLPI',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number to return (default: 50)' },
          },
        },
      },
      {
        name: 'glpi_get_document',
        description: 'Get detailed information about a document',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'The document ID' },
          },
          required: ['id'],
        },
      },

      // ==================== STATISTICS TOOLS ====================
      {
        name: 'glpi_get_ticket_stats',
        description: 'Get ticket statistics (counts by status)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'glpi_get_asset_stats',
        description: 'Get asset inventory statistics',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },

      // ==================== SESSION TOOLS ====================
      {
        name: 'glpi_get_session_info',
        description: 'Get current session information (profile, entities, permissions)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },

      // ==================== SEARCH TOOL ====================
      {
        name: 'glpi_search',
        description: 'Advanced search for items in GLPI using criteria',
        inputSchema: {
          type: 'object',
          properties: {
            itemtype: { type: 'string', description: 'Type of item to search (Ticket, User, Computer, Software, Problem, Change, etc.)' },
            field: { type: 'number', description: 'Field ID to search on' },
            searchtype: { type: 'string', enum: ['contains', 'equals', 'notequals', 'lessthan', 'morethan', 'under', 'notunder'], description: 'Type of search' },
            value: { type: 'string', description: 'Value to search for' },
          },
          required: ['itemtype', 'field', 'searchtype', 'value'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ==================== TICKET TOOLS ====================
      case 'glpi_list_tickets': {
        const limit = (args?.limit as number) || 50;
        const tickets = await glpiClient.getTickets({
          range: `0-${limit - 1}`,
          order: (args?.order as 'ASC' | 'DESC') || 'DESC',
        });

        const formattedTickets = tickets.map((t: any) => ({
          id: t.id,
          name: t.name,
          status: TICKET_STATUS[t.status] || t.status,
          urgency: TICKET_URGENCY[t.urgency] || t.urgency,
          date: t.date,
          date_mod: t.date_mod,
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify(formattedTickets, null, 2) }],
        };
      }

      case 'glpi_get_ticket': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Ticket ID is required');

        const ticket = await glpiClient.getTicket(id);
        const followups = await glpiClient.getTicketFollowups(id);
        const tasks = await glpiClient.getTicketTasks(id);
        const solutions = await glpiClient.getTicketSolutions(id);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...ticket,
              status_label: TICKET_STATUS[ticket.status],
              urgency_label: TICKET_URGENCY[ticket.urgency],
              followups_count: followups.length,
              tasks_count: tasks.length,
              solutions_count: solutions.length,
              followups,
              tasks,
              solutions,
            }, null, 2),
          }],
        };
      }

      case 'glpi_create_ticket': {
        const ticketName = args?.name as string;
        const content = args?.content as string;
        if (!ticketName || !content) {
          throw new McpError(ErrorCode.InvalidParams, 'name and content are required');
        }

        const result = await glpiClient.createTicket({
          name: ticketName,
          content,
          urgency: (args?.urgency as number) || 3,
          type: (args?.type as number) || 1,
          itilcategories_id: args?.category_id as number,
          _users_id_assign: args?.user_id_assign as number,
          _groups_id_assign: args?.group_id_assign as number,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      case 'glpi_update_ticket': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Ticket ID is required');

        const updates: any = {};
        if (args?.name) updates.name = args.name;
        if (args?.content) updates.content = args.content;
        if (args?.status) updates.status = args.status;
        if (args?.urgency) updates.urgency = args.urgency;

        await glpiClient.updateTicket(id, updates);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Ticket ${id} updated` }, null, 2) }],
        };
      }

      case 'glpi_delete_ticket': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Ticket ID is required');

        await glpiClient.deleteTicket(id, args?.force as boolean);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Ticket ${id} deleted` }, null, 2) }],
        };
      }

      case 'glpi_add_followup': {
        const ticketId = args?.ticket_id as number;
        const content = args?.content as string;
        if (!ticketId || !content) {
          throw new McpError(ErrorCode.InvalidParams, 'ticket_id and content are required');
        }

        const result = await glpiClient.addTicketFollowup(ticketId, content, args?.is_private as boolean);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, followup_id: result.id }, null, 2) }],
        };
      }

      case 'glpi_add_task': {
        const ticketId = args?.ticket_id as number;
        const content = args?.content as string;
        if (!ticketId || !content) {
          throw new McpError(ErrorCode.InvalidParams, 'ticket_id and content are required');
        }

        const result = await glpiClient.addTicketTask(ticketId, content, {
          is_private: args?.is_private as boolean,
          actiontime: args?.actiontime as number,
          state: args?.state as number,
          users_id_tech: args?.users_id_tech as number,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, task_id: result.id }, null, 2) }],
        };
      }

      case 'glpi_add_solution': {
        const ticketId = args?.ticket_id as number;
        const content = args?.content as string;
        if (!ticketId || !content) {
          throw new McpError(ErrorCode.InvalidParams, 'ticket_id and content are required');
        }

        const result = await glpiClient.addTicketSolution(ticketId, content, args?.solutiontypes_id as number);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, solution_id: result.id }, null, 2) }],
        };
      }

      case 'glpi_assign_ticket': {
        const ticketId = args?.ticket_id as number;
        const userId = args?.user_id as number;
        if (!ticketId || !userId) {
          throw new McpError(ErrorCode.InvalidParams, 'ticket_id and user_id are required');
        }

        const result = await glpiClient.assignTicket(ticketId, {
          users_id: userId,
          type: (args?.type as number) || 2,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, assignment_id: result.id }, null, 2) }],
        };
      }

      case 'glpi_get_ticket_tasks': {
        const ticketId = args?.ticket_id as number;
        if (!ticketId) throw new McpError(ErrorCode.InvalidParams, 'ticket_id is required');

        const tasks = await glpiClient.getTicketTasks(ticketId);

        return {
          content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }],
        };
      }

      case 'glpi_get_ticket_followups': {
        const ticketId = args?.ticket_id as number;
        if (!ticketId) throw new McpError(ErrorCode.InvalidParams, 'ticket_id is required');

        const followups = await glpiClient.getTicketFollowups(ticketId);

        return {
          content: [{ type: 'text', text: JSON.stringify(followups, null, 2) }],
        };
      }

      case 'glpi_get_ticket_solutions': {
        const ticketId = args?.ticket_id as number;
        if (!ticketId) throw new McpError(ErrorCode.InvalidParams, 'ticket_id is required');

        const solutions = await glpiClient.getTicketSolutions(ticketId);

        return {
          content: [{ type: 'text', text: JSON.stringify(solutions, null, 2) }],
        };
      }

      // ==================== PROBLEM TOOLS ====================
      case 'glpi_list_problems': {
        const limit = (args?.limit as number) || 50;
        const problems = await glpiClient.getProblems({
          range: `0-${limit - 1}`,
          order: (args?.order as 'ASC' | 'DESC') || 'DESC',
        });

        const formatted = problems.map((p: any) => ({
          id: p.id,
          name: p.name,
          status: PROBLEM_STATUS[p.status] || p.status,
          urgency: TICKET_URGENCY[p.urgency] || p.urgency,
          date: p.date,
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
        };
      }

      case 'glpi_get_problem': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Problem ID is required');

        const problem = await glpiClient.getProblem(id);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...problem,
              status_label: PROBLEM_STATUS[problem.status],
              urgency_label: TICKET_URGENCY[problem.urgency],
            }, null, 2),
          }],
        };
      }

      case 'glpi_create_problem': {
        const problemName = args?.name as string;
        const content = args?.content as string;
        if (!problemName || !content) {
          throw new McpError(ErrorCode.InvalidParams, 'name and content are required');
        }

        const result = await glpiClient.createProblem({
          name: problemName,
          content,
          urgency: args?.urgency as number,
          impact: args?.impact as number,
          priority: args?.priority as number,
          itilcategories_id: args?.category_id as number,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      case 'glpi_update_problem': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Problem ID is required');

        const updates: any = {};
        if (args?.name) updates.name = args.name;
        if (args?.content) updates.content = args.content;
        if (args?.status) updates.status = args.status;
        if (args?.urgency) updates.urgency = args.urgency;

        await glpiClient.updateProblem(id, updates);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Problem ${id} updated` }, null, 2) }],
        };
      }

      // ==================== CHANGE TOOLS ====================
      case 'glpi_list_changes': {
        const limit = (args?.limit as number) || 50;
        const changes = await glpiClient.getChanges({
          range: `0-${limit - 1}`,
          order: (args?.order as 'ASC' | 'DESC') || 'DESC',
        });

        const formatted = changes.map((c: any) => ({
          id: c.id,
          name: c.name,
          status: CHANGE_STATUS[c.status] || c.status,
          urgency: TICKET_URGENCY[c.urgency] || c.urgency,
          date: c.date,
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
        };
      }

      case 'glpi_get_change': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Change ID is required');

        const change = await glpiClient.getChange(id);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...change,
              status_label: CHANGE_STATUS[change.status],
              urgency_label: TICKET_URGENCY[change.urgency],
            }, null, 2),
          }],
        };
      }

      case 'glpi_create_change': {
        const changeName = args?.name as string;
        const content = args?.content as string;
        if (!changeName || !content) {
          throw new McpError(ErrorCode.InvalidParams, 'name and content are required');
        }

        const result = await glpiClient.createChange({
          name: changeName,
          content,
          urgency: args?.urgency as number,
          impact: args?.impact as number,
          priority: args?.priority as number,
          itilcategories_id: args?.category_id as number,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      case 'glpi_update_change': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Change ID is required');

        const updates: any = {};
        if (args?.name) updates.name = args.name;
        if (args?.content) updates.content = args.content;
        if (args?.status) updates.status = args.status;

        await glpiClient.updateChange(id, updates);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Change ${id} updated` }, null, 2) }],
        };
      }

      // ==================== COMPUTER TOOLS ====================
      case 'glpi_list_computers': {
        const limit = (args?.limit as number) || 50;
        const computers = await glpiClient.getComputers({
          range: `0-${limit - 1}`,
          is_deleted: args?.include_deleted as boolean,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(computers, null, 2) }],
        };
      }

      case 'glpi_get_computer': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Computer ID is required');

        const computer = await glpiClient.getComputer(id, {
          with_softwares: args?.with_softwares as boolean,
          with_connections: args?.with_connections as boolean,
          with_networkports: args?.with_networkports as boolean,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(computer, null, 2) }],
        };
      }

      case 'glpi_create_computer': {
        const computerName = args?.name as string;
        if (!computerName) throw new McpError(ErrorCode.InvalidParams, 'name is required');

        const result = await glpiClient.createComputer({
          name: computerName,
          serial: args?.serial as string,
          otherserial: args?.otherserial as string,
          contact: args?.contact as string,
          comment: args?.comment as string,
          locations_id: args?.locations_id as number,
          states_id: args?.states_id as number,
          computertypes_id: args?.computertypes_id as number,
          manufacturers_id: args?.manufacturers_id as number,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      case 'glpi_update_computer': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Computer ID is required');

        const updates: any = {};
        if (args?.name) updates.name = args.name;
        if (args?.serial) updates.serial = args.serial;
        if (args?.comment) updates.comment = args.comment;
        if (args?.locations_id) updates.locations_id = args.locations_id;
        if (args?.states_id) updates.states_id = args.states_id;

        await glpiClient.updateComputer(id, updates);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Computer ${id} updated` }, null, 2) }],
        };
      }

      case 'glpi_delete_computer': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Computer ID is required');

        await glpiClient.deleteComputer(id, args?.force as boolean);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Computer ${id} deleted` }, null, 2) }],
        };
      }

      // ==================== SOFTWARE TOOLS ====================
      case 'glpi_list_softwares': {
        const limit = (args?.limit as number) || 50;
        const softwares = await glpiClient.getSoftwares({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(softwares, null, 2) }],
        };
      }

      case 'glpi_get_software': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Software ID is required');

        const software = await glpiClient.getSoftware(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(software, null, 2) }],
        };
      }

      case 'glpi_create_software': {
        const softwareName = args?.name as string;
        if (!softwareName) throw new McpError(ErrorCode.InvalidParams, 'name is required');

        const result = await glpiClient.createSoftware({
          name: softwareName,
          comment: args?.comment as string,
          manufacturers_id: args?.manufacturers_id as number,
          softwarecategories_id: args?.softwarecategories_id as number,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      // ==================== NETWORK EQUIPMENT TOOLS ====================
      case 'glpi_list_network_equipments': {
        const limit = (args?.limit as number) || 50;
        const equipments = await glpiClient.getNetworkEquipments({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(equipments, null, 2) }],
        };
      }

      case 'glpi_get_network_equipment': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Equipment ID is required');

        const equipment = await glpiClient.getNetworkEquipment(id, {
          with_networkports: args?.with_networkports as boolean,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(equipment, null, 2) }],
        };
      }

      // ==================== PRINTER TOOLS ====================
      case 'glpi_list_printers': {
        const limit = (args?.limit as number) || 50;
        const printers = await glpiClient.getPrinters({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(printers, null, 2) }],
        };
      }

      case 'glpi_get_printer': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Printer ID is required');

        const printer = await glpiClient.getPrinter(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(printer, null, 2) }],
        };
      }

      // ==================== MONITOR TOOLS ====================
      case 'glpi_list_monitors': {
        const limit = (args?.limit as number) || 50;
        const monitors = await glpiClient.getMonitors({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(monitors, null, 2) }],
        };
      }

      case 'glpi_get_monitor': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Monitor ID is required');

        const monitor = await glpiClient.getMonitor(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(monitor, null, 2) }],
        };
      }

      // ==================== PHONE TOOLS ====================
      case 'glpi_list_phones': {
        const limit = (args?.limit as number) || 50;
        const phones = await glpiClient.getPhones({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(phones, null, 2) }],
        };
      }

      case 'glpi_get_phone': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Phone ID is required');

        const phone = await glpiClient.getPhone(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(phone, null, 2) }],
        };
      }

      // ==================== KNOWLEDGE BASE TOOLS ====================
      case 'glpi_list_knowbase': {
        const limit = (args?.limit as number) || 50;
        const items = await glpiClient.getKnowbaseItems({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
        };
      }

      case 'glpi_get_knowbase_item': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Article ID is required');

        const item = await glpiClient.getKnowbaseItem(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(item, null, 2) }],
        };
      }

      case 'glpi_search_knowbase': {
        const query = args?.query as string;
        if (!query) throw new McpError(ErrorCode.InvalidParams, 'query is required');

        const results = await glpiClient.searchKnowbase(query);

        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      }

      case 'glpi_create_knowbase_item': {
        const itemName = args?.name as string;
        const answer = args?.answer as string;
        if (!itemName || !answer) {
          throw new McpError(ErrorCode.InvalidParams, 'name and answer are required');
        }

        const result = await glpiClient.createKnowbaseItem({
          name: itemName,
          answer,
          is_faq: args?.is_faq ? 1 : 0,
          knowbaseitemcategories_id: args?.knowbaseitemcategories_id as number,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      // ==================== CONTRACT TOOLS ====================
      case 'glpi_list_contracts': {
        const limit = (args?.limit as number) || 50;
        const contracts = await glpiClient.getContracts({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(contracts, null, 2) }],
        };
      }

      case 'glpi_get_contract': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Contract ID is required');

        const contract = await glpiClient.getContract(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(contract, null, 2) }],
        };
      }

      case 'glpi_create_contract': {
        const contractName = args?.name as string;
        if (!contractName) throw new McpError(ErrorCode.InvalidParams, 'name is required');

        const result = await glpiClient.createContract({
          name: contractName,
          num: args?.num as string,
          begin_date: args?.begin_date as string,
          duration: args?.duration as number,
          notice: args?.notice as number,
          comment: args?.comment as string,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      // ==================== SUPPLIER TOOLS ====================
      case 'glpi_list_suppliers': {
        const limit = (args?.limit as number) || 50;
        const suppliers = await glpiClient.getSuppliers({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(suppliers, null, 2) }],
        };
      }

      case 'glpi_get_supplier': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Supplier ID is required');

        const supplier = await glpiClient.getSupplier(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(supplier, null, 2) }],
        };
      }

      case 'glpi_create_supplier': {
        const supplierName = args?.name as string;
        if (!supplierName) throw new McpError(ErrorCode.InvalidParams, 'name is required');

        const result = await glpiClient.createSupplier({
          name: supplierName,
          address: args?.address as string,
          postcode: args?.postcode as string,
          town: args?.town as string,
          country: args?.country as string,
          website: args?.website as string,
          phonenumber: args?.phonenumber as string,
          email: args?.email as string,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      // ==================== LOCATION TOOLS ====================
      case 'glpi_list_locations': {
        const limit = (args?.limit as number) || 50;
        const locations = await glpiClient.getLocations({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(locations, null, 2) }],
        };
      }

      case 'glpi_get_location': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Location ID is required');

        const location = await glpiClient.getLocation(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(location, null, 2) }],
        };
      }

      case 'glpi_create_location': {
        const locationName = args?.name as string;
        if (!locationName) throw new McpError(ErrorCode.InvalidParams, 'name is required');

        const result = await glpiClient.createLocation({
          name: locationName,
          address: args?.address as string,
          postcode: args?.postcode as string,
          town: args?.town as string,
          building: args?.building as string,
          room: args?.room as string,
          locations_id: args?.locations_id as number,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      // ==================== PROJECT TOOLS ====================
      case 'glpi_list_projects': {
        const limit = (args?.limit as number) || 50;
        const projects = await glpiClient.getProjects({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
        };
      }

      case 'glpi_get_project': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Project ID is required');

        const project = await glpiClient.getProject(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(project, null, 2) }],
        };
      }

      case 'glpi_create_project': {
        const projectName = args?.name as string;
        if (!projectName) throw new McpError(ErrorCode.InvalidParams, 'name is required');

        const result = await glpiClient.createProject({
          name: projectName,
          code: args?.code as string,
          content: args?.content as string,
          priority: args?.priority as number,
          plan_start_date: args?.plan_start_date as string,
          plan_end_date: args?.plan_end_date as string,
          users_id: args?.users_id as number,
          groups_id: args?.groups_id as number,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      case 'glpi_update_project': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Project ID is required');

        const updates: any = {};
        if (args?.name) updates.name = args.name;
        if (args?.content) updates.content = args.content;
        if (args?.percent_done !== undefined) updates.percent_done = args.percent_done;
        if (args?.real_start_date) updates.real_start_date = args.real_start_date;
        if (args?.real_end_date) updates.real_end_date = args.real_end_date;

        await glpiClient.updateProject(id, updates);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Project ${id} updated` }, null, 2) }],
        };
      }

      // ==================== USER TOOLS ====================
      case 'glpi_list_users': {
        const limit = (args?.limit as number) || 50;
        const users = await glpiClient.getUsers({
          range: `0-${limit - 1}`,
          is_active: args?.active_only !== false,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(users, null, 2) }],
        };
      }

      case 'glpi_get_user': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'User ID is required');

        const user = await glpiClient.getUser(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(user, null, 2) }],
        };
      }

      case 'glpi_search_user': {
        const userName = args?.name as string;
        if (!userName) throw new McpError(ErrorCode.InvalidParams, 'name is required');

        const user = await glpiClient.getUserByName(userName);

        return {
          content: [{ type: 'text', text: JSON.stringify(user, null, 2) }],
        };
      }

      case 'glpi_create_user': {
        const userName = args?.name as string;
        if (!userName) throw new McpError(ErrorCode.InvalidParams, 'name is required');

        const result = await glpiClient.createUser({
          name: userName,
          password: args?.password as string,
          realname: args?.realname as string,
          firstname: args?.firstname as string,
          email: args?.email as string,
          phone: args?.phone as string,
          profiles_id: args?.profiles_id as number,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      // ==================== GROUP TOOLS ====================
      case 'glpi_list_groups': {
        const limit = (args?.limit as number) || 50;
        const groups = await glpiClient.getGroups({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(groups, null, 2) }],
        };
      }

      case 'glpi_get_group': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Group ID is required');

        const group = await glpiClient.getGroup(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(group, null, 2) }],
        };
      }

      case 'glpi_create_group': {
        const groupName = args?.name as string;
        if (!groupName) throw new McpError(ErrorCode.InvalidParams, 'name is required');

        const result = await glpiClient.createGroup({
          name: groupName,
          comment: args?.comment as string,
          is_requester: args?.is_requester ? 1 : 0,
          is_assign: args?.is_assign ? 1 : 0,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      case 'glpi_add_user_to_group': {
        const userId = args?.user_id as number;
        const groupId = args?.group_id as number;
        if (!userId || !groupId) {
          throw new McpError(ErrorCode.InvalidParams, 'user_id and group_id are required');
        }

        const result = await glpiClient.addUserToGroup(userId, groupId, args?.is_manager as boolean);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
        };
      }

      // ==================== CATEGORY TOOLS ====================
      case 'glpi_list_categories': {
        const limit = (args?.limit as number) || 50;
        const categories = await glpiClient.getCategories({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(categories, null, 2) }],
        };
      }

      // ==================== ENTITY TOOLS ====================
      case 'glpi_list_entities': {
        const limit = (args?.limit as number) || 50;
        const entities = await glpiClient.getEntities({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(entities, null, 2) }],
        };
      }

      case 'glpi_get_entity': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Entity ID is required');

        const entity = await glpiClient.getEntity(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(entity, null, 2) }],
        };
      }

      // ==================== DOCUMENT TOOLS ====================
      case 'glpi_list_documents': {
        const limit = (args?.limit as number) || 50;
        const documents = await glpiClient.getDocuments({ range: `0-${limit - 1}` });

        return {
          content: [{ type: 'text', text: JSON.stringify(documents, null, 2) }],
        };
      }

      case 'glpi_get_document': {
        const id = args?.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'Document ID is required');

        const document = await glpiClient.getDocument(id);

        return {
          content: [{ type: 'text', text: JSON.stringify(document, null, 2) }],
        };
      }

      // ==================== STATISTICS TOOLS ====================
      case 'glpi_get_ticket_stats': {
        const stats = await glpiClient.getTicketStats();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...stats,
              summary: `Total: ${stats.total} tickets - ${stats.new} new, ${stats.processing} processing, ${stats.pending} pending, ${stats.solved} solved, ${stats.closed} closed`,
            }, null, 2),
          }],
        };
      }

      case 'glpi_get_asset_stats': {
        const stats = await glpiClient.getAssetStats();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...stats,
              total: stats.computers + stats.monitors + stats.printers + stats.networkEquipments + stats.phones,
            }, null, 2),
          }],
        };
      }

      // ==================== SESSION TOOLS ====================
      case 'glpi_get_session_info': {
        const [profile, profiles, entities] = await Promise.all([
          glpiClient.getActiveProfile(),
          glpiClient.getMyProfiles(),
          glpiClient.getMyEntities(),
        ]);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              active_profile: profile,
              available_profiles: profiles,
              entities,
            }, null, 2),
          }],
        };
      }

      // ==================== SEARCH TOOL ====================
      case 'glpi_search': {
        const itemtype = args?.itemtype as string;
        const field = args?.field as number;
        const searchtype = args?.searchtype as string;
        const value = args?.value as string;

        if (!itemtype || field === undefined || !searchtype || value === undefined) {
          throw new McpError(ErrorCode.InvalidParams, 'itemtype, field, searchtype, and value are required');
        }

        const results = await glpiClient.search(itemtype, [
          { field, searchtype: searchtype as any, value },
        ]);

        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.InternalError,
      `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// Define available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'glpi://tickets/open',
        name: 'Open Tickets',
        description: 'List of all open tickets (status: New, Processing, Pending)',
        mimeType: 'application/json',
      },
      {
        uri: 'glpi://tickets/recent',
        name: 'Recent Tickets',
        description: 'Most recently modified tickets',
        mimeType: 'application/json',
      },
      {
        uri: 'glpi://problems/open',
        name: 'Open Problems',
        description: 'List of all open problems',
        mimeType: 'application/json',
      },
      {
        uri: 'glpi://changes/pending',
        name: 'Pending Changes',
        description: 'List of pending change requests',
        mimeType: 'application/json',
      },
      {
        uri: 'glpi://computers',
        name: 'Computers',
        description: 'List of all computers in inventory',
        mimeType: 'application/json',
      },
      {
        uri: 'glpi://groups',
        name: 'Groups',
        description: 'List of all groups',
        mimeType: 'application/json',
      },
      {
        uri: 'glpi://categories',
        name: 'Categories',
        description: 'List of ticket categories',
        mimeType: 'application/json',
      },
      {
        uri: 'glpi://stats/tickets',
        name: 'Ticket Statistics',
        description: 'Ticket counts by status',
        mimeType: 'application/json',
      },
      {
        uri: 'glpi://stats/assets',
        name: 'Asset Statistics',
        description: 'Asset inventory counts',
        mimeType: 'application/json',
      },
    ],
  };
});

// Handle resource reads
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  try {
    switch (uri) {
      case 'glpi://tickets/open': {
        const tickets = await glpiClient.getTickets({ range: '0-99' });
        const openTickets = tickets.filter((t: any) => t.status < 5);
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(openTickets, null, 2),
          }],
        };
      }

      case 'glpi://tickets/recent': {
        const tickets = await glpiClient.getTickets({ range: '0-19', order: 'DESC' });
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(tickets, null, 2),
          }],
        };
      }

      case 'glpi://problems/open': {
        const problems = await glpiClient.getProblems({ range: '0-99' });
        const openProblems = problems.filter((p: any) => p.status < 5);
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(openProblems, null, 2),
          }],
        };
      }

      case 'glpi://changes/pending': {
        const changes = await glpiClient.getChanges({ range: '0-99' });
        const pendingChanges = changes.filter((c: any) => c.status < 8);
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(pendingChanges, null, 2),
          }],
        };
      }

      case 'glpi://computers': {
        const computers = await glpiClient.getComputers({ range: '0-99', is_deleted: false });
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(computers, null, 2),
          }],
        };
      }

      case 'glpi://groups': {
        const groups = await glpiClient.getGroups({ range: '0-99' });
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(groups, null, 2),
          }],
        };
      }

      case 'glpi://categories': {
        const categories = await glpiClient.getCategories({ range: '0-99' });
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(categories, null, 2),
          }],
        };
      }

      case 'glpi://stats/tickets': {
        const stats = await glpiClient.getTicketStats();
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(stats, null, 2),
          }],
        };
      }

      case 'glpi://stats/assets': {
        const stats = await glpiClient.getAssetStats();
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(stats, null, 2),
          }],
        };
      }

      default:
        throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.InternalError,
      `Error reading resource: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// Main function
async function main() {
  try {
    const config = getConfig();
    glpiClient = new GlpiClient(config);

    // Initialize session
    await glpiClient.initSession();
    console.error('GLPI session initialized successfully');

    // Start the server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP GLPI Server v2.0 running on stdio');

    // Handle shutdown
    process.on('SIGINT', async () => {
      await glpiClient.killSession();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await glpiClient.killSession();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
