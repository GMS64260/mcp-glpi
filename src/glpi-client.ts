/**
 * GLPI REST API Client v2.0
 * Full-featured client for GLPI IT Service Management
 */

export interface GlpiConfig {
  url: string;
  appToken?: string;
  userToken?: string;
  username?: string;
  password?: string;
}

// ==================== INTERFACES ====================

export interface GlpiTicket {
  id: number;
  name: string;
  content: string;
  status: number;
  urgency: number;
  priority: number;
  impact: number;
  type: number;
  date: string;
  date_mod: string;
  solvedate?: string;
  closedate?: string;
  users_id_recipient: number;
  users_id_lastupdater: number;
  itilcategories_id: number;
  entities_id: number;
  time_to_resolve?: string;
  actiontime: number;
}

export interface GlpiUser {
  id: number;
  name: string;
  realname: string;
  firstname: string;
  email: string;
  phone: string;
  mobile: string;
  is_active: number;
  locations_id: number;
  profiles_id: number;
}

export interface GlpiGroup {
  id: number;
  name: string;
  completename: string;
  comment: string;
  entities_id: number;
  is_recursive: number;
}

export interface GlpiCategory {
  id: number;
  name: string;
  completename: string;
  itilcategories_id: number;
  level: number;
}

export interface GlpiComputer {
  id: number;
  name: string;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: number;
  groups_id_tech: number;
  comment: string;
  date_mod: string;
  operatingsystems_id: number;
  locations_id: number;
  states_id: number;
  computertypes_id: number;
  manufacturers_id: number;
  computermodels_id: number;
  uuid: string;
  is_deleted: number;
  entities_id: number;
}

export interface GlpiSoftware {
  id: number;
  name: string;
  comment: string;
  locations_id: number;
  users_id_tech: number;
  groups_id_tech: number;
  is_helpdesk_visible: number;
  manufacturers_id: number;
  softwarecategories_id: number;
  is_deleted: number;
  entities_id: number;
}

export interface GlpiProblem {
  id: number;
  name: string;
  content: string;
  status: number;
  urgency: number;
  impact: number;
  priority: number;
  date: string;
  date_mod: string;
  solvedate?: string;
  closedate?: string;
  users_id_recipient: number;
  itilcategories_id: number;
  entities_id: number;
}

export interface GlpiChange {
  id: number;
  name: string;
  content: string;
  status: number;
  urgency: number;
  impact: number;
  priority: number;
  date: string;
  date_mod: string;
  solvedate?: string;
  closedate?: string;
  users_id_recipient: number;
  itilcategories_id: number;
  entities_id: number;
}

export interface GlpiKnowbaseItem {
  id: number;
  name: string;
  answer: string;
  is_faq: number;
  view: number;
  date: string;
  date_mod: string;
  users_id: number;
  knowbaseitemcategories_id: number;
}

export interface GlpiContract {
  id: number;
  name: string;
  num: string;
  contracttypes_id: number;
  begin_date: string;
  duration: number;
  notice: number;
  periodicity: number;
  billing: number;
  comment: string;
  renewal: number;
  entities_id: number;
}

export interface GlpiSupplier {
  id: number;
  name: string;
  suppliertypes_id: number;
  address: string;
  postcode: string;
  town: string;
  state: string;
  country: string;
  website: string;
  phonenumber: string;
  fax: string;
  email: string;
  comment: string;
  entities_id: number;
}

export interface GlpiLocation {
  id: number;
  name: string;
  completename: string;
  locations_id: number;
  address: string;
  postcode: string;
  town: string;
  country: string;
  building: string;
  room: string;
  entities_id: number;
}

export interface GlpiNetworkEquipment {
  id: number;
  name: string;
  ram: string;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: number;
  groups_id_tech: number;
  date_mod: string;
  comment: string;
  locations_id: number;
  networks_id: number;
  networkequipmenttypes_id: number;
  networkequipmentmodels_id: number;
  manufacturers_id: number;
  is_deleted: number;
  entities_id: number;
}

export interface GlpiPrinter {
  id: number;
  name: string;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: number;
  groups_id_tech: number;
  have_serial: number;
  have_parallel: number;
  have_usb: number;
  have_wifi: number;
  have_ethernet: number;
  comment: string;
  date_mod: string;
  locations_id: number;
  printertypes_id: number;
  printermodels_id: number;
  manufacturers_id: number;
  is_deleted: number;
  entities_id: number;
}

export interface GlpiMonitor {
  id: number;
  name: string;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: number;
  groups_id_tech: number;
  comment: string;
  date_mod: string;
  size: number;
  have_micro: number;
  have_speaker: number;
  have_subd: number;
  have_bnc: number;
  have_dvi: number;
  have_pivot: number;
  have_hdmi: number;
  have_displayport: number;
  locations_id: number;
  monitortypes_id: number;
  monitormodels_id: number;
  manufacturers_id: number;
  is_deleted: number;
  entities_id: number;
}

export interface GlpiPhone {
  id: number;
  name: string;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: number;
  groups_id_tech: number;
  comment: string;
  date_mod: string;
  locations_id: number;
  phonetypes_id: number;
  phonemodels_id: number;
  manufacturers_id: number;
  is_deleted: number;
  entities_id: number;
  firmware: string;
  number_line: string;
  have_headset: number;
  have_hp: number;
}

export interface GlpiEntity {
  id: number;
  name: string;
  completename: string;
  entities_id: number;
  level: number;
  comment: string;
  address: string;
  postcode: string;
  town: string;
  country: string;
  website: string;
  phonenumber: string;
  fax: string;
  email: string;
}

export interface GlpiProject {
  id: number;
  name: string;
  code: string;
  priority: number;
  content: string;
  comment: string;
  date: string;
  date_mod: string;
  plan_start_date: string;
  plan_end_date: string;
  real_start_date: string;
  real_end_date: string;
  percent_done: number;
  projectstates_id: number;
  projecttypes_id: number;
  users_id: number;
  groups_id: number;
  entities_id: number;
}

export interface GlpiDocument {
  id: number;
  name: string;
  filename: string;
  filepath: string;
  mime: string;
  date_mod: string;
  comment: string;
  sha1sum: string;
  documentcategories_id: number;
  users_id: number;
  entities_id: number;
}

// ==================== CLIENT ====================

export class GlpiClient {
  private config: GlpiConfig;
  private sessionToken: string | null = null;

  constructor(config: GlpiConfig) {
    this.config = config;
    this.config.url = config.url.replace(/\/$/, '');
  }

  private getHeaders(includeSession: boolean = true): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.appToken) {
      headers['App-Token'] = this.config.appToken;
    }

    if (includeSession && this.sessionToken) {
      headers['Session-Token'] = this.sessionToken;
    }

    return headers;
  }

  async initSession(): Promise<string> {
    const headers = this.getHeaders(false);

    if (this.config.userToken) {
      headers['Authorization'] = `user_token ${this.config.userToken}`;
    } else if (this.config.username && this.config.password) {
      const credentials = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    } else {
      throw new Error('No authentication method provided. Set userToken or username/password.');
    }

    const response = await fetch(`${this.config.url}/apirest.php/initSession`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to init session: ${response.status} - ${error}`);
    }

    const data = await response.json() as { session_token: string };
    this.sessionToken = data.session_token;
    return this.sessionToken;
  }

  async killSession(): Promise<void> {
    if (!this.sessionToken) return;

    await fetch(`${this.config.url}/apirest.php/killSession`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    this.sessionToken = null;
  }

  async ensureSession(): Promise<void> {
    if (!this.sessionToken) {
      await this.initSession();
    }
  }

  // ==================== GENERIC METHODS ====================

  private async getItems<T>(itemtype: string, options: {
    range?: string;
    sort?: number;
    order?: 'ASC' | 'DESC';
    searchText?: Record<string, string>;
    is_deleted?: boolean;
    expand_dropdowns?: boolean;
    with_networkports?: boolean;
    with_infocoms?: boolean;
    with_contracts?: boolean;
    with_documents?: boolean;
    with_tickets?: boolean;
    with_problems?: boolean;
    with_changes?: boolean;
    with_logs?: boolean;
  } = {}): Promise<T[]> {
    await this.ensureSession();

    const params = new URLSearchParams();
    if (options.range) params.append('range', options.range);
    if (options.sort) params.append('sort', options.sort.toString());
    if (options.order) params.append('order', options.order);
    if (options.is_deleted !== undefined) params.append('is_deleted', options.is_deleted ? '1' : '0');
    if (options.expand_dropdowns) params.append('expand_dropdowns', 'true');
    if (options.with_networkports) params.append('with_networkports', 'true');
    if (options.with_infocoms) params.append('with_infocoms', 'true');
    if (options.with_contracts) params.append('with_contracts', 'true');
    if (options.with_documents) params.append('with_documents', 'true');
    if (options.with_tickets) params.append('with_tickets', 'true');
    if (options.with_problems) params.append('with_problems', 'true');
    if (options.with_changes) params.append('with_changes', 'true');
    if (options.with_logs) params.append('with_logs', 'true');

    if (options.searchText) {
      Object.entries(options.searchText).forEach(([key, value]) => {
        params.append(`searchText[${key}]`, value);
      });
    }

    const response = await fetch(`${this.config.url}/apirest.php/${itemtype}?${params.toString()}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get ${itemtype}: ${response.status}`);
    }

    return response.json() as Promise<T[]>;
  }

  private async getItem<T>(itemtype: string, id: number, options: {
    expand_dropdowns?: boolean;
    with_networkports?: boolean;
    with_infocoms?: boolean;
    with_contracts?: boolean;
    with_documents?: boolean;
    with_tickets?: boolean;
    with_problems?: boolean;
    with_changes?: boolean;
    with_logs?: boolean;
    with_softwares?: boolean;
    with_connections?: boolean;
    with_disks?: boolean;
  } = {}): Promise<T> {
    await this.ensureSession();

    const params = new URLSearchParams();
    if (options.expand_dropdowns) params.append('expand_dropdowns', 'true');
    if (options.with_networkports) params.append('with_networkports', 'true');
    if (options.with_infocoms) params.append('with_infocoms', 'true');
    if (options.with_contracts) params.append('with_contracts', 'true');
    if (options.with_documents) params.append('with_documents', 'true');
    if (options.with_tickets) params.append('with_tickets', 'true');
    if (options.with_problems) params.append('with_problems', 'true');
    if (options.with_changes) params.append('with_changes', 'true');
    if (options.with_logs) params.append('with_logs', 'true');
    if (options.with_softwares) params.append('with_softwares', 'true');
    if (options.with_connections) params.append('with_connections', 'true');
    if (options.with_disks) params.append('with_disks', 'true');

    const response = await fetch(`${this.config.url}/apirest.php/${itemtype}/${id}?${params.toString()}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get ${itemtype} ${id}: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  private async createItem<T>(itemtype: string, data: Record<string, any>): Promise<{ id: number; message?: string }> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/${itemtype}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ input: data }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create ${itemtype}: ${response.status} - ${error}`);
    }

    return response.json() as Promise<{ id: number; message?: string }>;
  }

  private async updateItem(itemtype: string, id: number, data: Record<string, any>): Promise<boolean> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/${itemtype}/${id}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({ input: data }),
    });

    if (!response.ok) {
      throw new Error(`Failed to update ${itemtype} ${id}: ${response.status}`);
    }

    return true;
  }

  private async deleteItem(itemtype: string, id: number, force: boolean = false, history: boolean = true): Promise<boolean> {
    await this.ensureSession();

    const params = new URLSearchParams();
    if (force) params.append('force_purge', '1');
    if (!history) params.append('history', '0');

    const response = await fetch(`${this.config.url}/apirest.php/${itemtype}/${id}?${params.toString()}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to delete ${itemtype} ${id}: ${response.status}`);
    }

    return true;
  }

  // ==================== TICKETS ====================

  async getTickets(options: { range?: string; sort?: number; order?: 'ASC' | 'DESC'; is_deleted?: boolean } = {}) {
    return this.getItems<GlpiTicket>('Ticket', options);
  }

  async getTicket(id: number, options: { expand_dropdowns?: boolean; with_logs?: boolean } = {}) {
    return this.getItem<GlpiTicket>('Ticket', id, options);
  }

  async createTicket(ticket: {
    name: string;
    content: string;
    urgency?: number;
    priority?: number;
    impact?: number;
    type?: number;
    itilcategories_id?: number;
    entities_id?: number;
    _users_id_assign?: number;
    _groups_id_assign?: number;
    _users_id_requester?: number;
    _groups_id_requester?: number;
    time_to_resolve?: string;
  }) {
    return this.createItem('Ticket', ticket);
  }

  async updateTicket(id: number, updates: Partial<GlpiTicket>) {
    return this.updateItem('Ticket', id, updates);
  }

  async deleteTicket(id: number, force: boolean = false) {
    return this.deleteItem('Ticket', id, force);
  }

  async addTicketFollowup(ticketId: number, content: string, isPrivate: boolean = false): Promise<{ id: number }> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/ITILFollowup`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        input: {
          itemtype: 'Ticket',
          items_id: ticketId,
          content: content,
          is_private: isPrivate ? 1 : 0,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to add followup: ${response.status} - ${error}`);
    }

    return response.json() as Promise<{ id: number }>;
  }

  async addTicketTask(ticketId: number, content: string, options: {
    is_private?: boolean;
    actiontime?: number;
    state?: number;
    users_id_tech?: number;
    groups_id_tech?: number;
    begin?: string;
    end?: string;
  } = {}): Promise<{ id: number }> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/TicketTask`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        input: {
          tickets_id: ticketId,
          content: content,
          is_private: options.is_private ? 1 : 0,
          actiontime: options.actiontime || 0,
          state: options.state || 1,
          users_id_tech: options.users_id_tech,
          groups_id_tech: options.groups_id_tech,
          begin: options.begin,
          end: options.end,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to add task: ${response.status} - ${error}`);
    }

    return response.json() as Promise<{ id: number }>;
  }

  async addTicketSolution(ticketId: number, content: string, solutiontypes_id?: number): Promise<{ id: number }> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/ITILSolution`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        input: {
          itemtype: 'Ticket',
          items_id: ticketId,
          content: content,
          solutiontypes_id: solutiontypes_id || 0,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to add solution: ${response.status} - ${error}`);
    }

    return response.json() as Promise<{ id: number }>;
  }

  async getTicketFollowups(ticketId: number): Promise<any[]> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/Ticket/${ticketId}/ITILFollowup`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get followups: ${response.status}`);
    }

    return response.json() as Promise<any[]>;
  }

  async getTicketTasks(ticketId: number): Promise<any[]> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/Ticket/${ticketId}/TicketTask`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get tasks: ${response.status}`);
    }

    return response.json() as Promise<any[]>;
  }

  async assignTicket(ticketId: number, options: {
    users_id?: number;
    groups_id?: number;
    type?: number; // 1=requester, 2=assigned, 3=observer
  }): Promise<{ id: number }> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/Ticket_User`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        input: {
          tickets_id: ticketId,
          users_id: options.users_id,
          type: options.type || 2,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to assign ticket: ${response.status} - ${error}`);
    }

    return response.json() as Promise<{ id: number }>;
  }

  // ==================== PROBLEMS ====================

  async getProblems(options: { range?: string; order?: 'ASC' | 'DESC' } = {}) {
    return this.getItems<GlpiProblem>('Problem', options);
  }

  async getProblem(id: number) {
    return this.getItem<GlpiProblem>('Problem', id);
  }

  async createProblem(problem: {
    name: string;
    content: string;
    urgency?: number;
    impact?: number;
    priority?: number;
    itilcategories_id?: number;
    entities_id?: number;
  }) {
    return this.createItem('Problem', problem);
  }

  async updateProblem(id: number, updates: Partial<GlpiProblem>) {
    return this.updateItem('Problem', id, updates);
  }

  // ==================== CHANGES ====================

  async getChanges(options: { range?: string; order?: 'ASC' | 'DESC' } = {}) {
    return this.getItems<GlpiChange>('Change', options);
  }

  async getChange(id: number) {
    return this.getItem<GlpiChange>('Change', id);
  }

  async createChange(change: {
    name: string;
    content: string;
    urgency?: number;
    impact?: number;
    priority?: number;
    itilcategories_id?: number;
    entities_id?: number;
  }) {
    return this.createItem('Change', change);
  }

  async updateChange(id: number, updates: Partial<GlpiChange>) {
    return this.updateItem('Change', id, updates);
  }

  // ==================== USERS ====================

  async getUsers(options: { range?: string; is_active?: boolean } = {}) {
    const searchText = options.is_active !== undefined ? { is_active: options.is_active ? '1' : '0' } : undefined;
    return this.getItems<GlpiUser>('User', { ...options, searchText });
  }

  async getUser(id: number) {
    return this.getItem<GlpiUser>('User', id);
  }

  async getUserByName(name: string): Promise<GlpiUser | null> {
    const users = await this.getItems<GlpiUser>('User', { searchText: { name } });
    return users.length > 0 ? users[0] : null;
  }

  async createUser(user: {
    name: string;
    password?: string;
    realname?: string;
    firstname?: string;
    email?: string;
    phone?: string;
    mobile?: string;
    profiles_id?: number;
    entities_id?: number;
    is_active?: number;
  }) {
    return this.createItem('User', user);
  }

  async updateUser(id: number, updates: Partial<GlpiUser>) {
    return this.updateItem('User', id, updates);
  }

  // ==================== GROUPS ====================

  async getGroups(options: { range?: string } = {}) {
    return this.getItems<GlpiGroup>('Group', options);
  }

  async getGroup(id: number) {
    return this.getItem<GlpiGroup>('Group', id);
  }

  async createGroup(group: {
    name: string;
    comment?: string;
    entities_id?: number;
    is_recursive?: number;
    is_requester?: number;
    is_assign?: number;
    is_notify?: number;
  }) {
    return this.createItem('Group', group);
  }

  async addUserToGroup(userId: number, groupId: number, isManager: boolean = false): Promise<{ id: number }> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/Group_User`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        input: {
          users_id: userId,
          groups_id: groupId,
          is_manager: isManager ? 1 : 0,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to add user to group: ${response.status} - ${error}`);
    }

    return response.json() as Promise<{ id: number }>;
  }

  // ==================== COMPUTERS ====================

  async getComputers(options: { range?: string; is_deleted?: boolean; expand_dropdowns?: boolean } = {}) {
    return this.getItems<GlpiComputer>('Computer', options);
  }

  async getComputer(id: number, options: { with_softwares?: boolean; with_connections?: boolean; with_disks?: boolean; with_networkports?: boolean } = {}) {
    return this.getItem<GlpiComputer>('Computer', id, options);
  }

  async createComputer(computer: {
    name: string;
    serial?: string;
    otherserial?: string;
    contact?: string;
    contact_num?: string;
    users_id_tech?: number;
    groups_id_tech?: number;
    comment?: string;
    operatingsystems_id?: number;
    locations_id?: number;
    states_id?: number;
    computertypes_id?: number;
    manufacturers_id?: number;
    computermodels_id?: number;
    entities_id?: number;
  }) {
    return this.createItem('Computer', computer);
  }

  async updateComputer(id: number, updates: Partial<GlpiComputer>) {
    return this.updateItem('Computer', id, updates);
  }

  async deleteComputer(id: number, force: boolean = false) {
    return this.deleteItem('Computer', id, force);
  }

  // ==================== SOFTWARE ====================

  async getSoftwares(options: { range?: string; is_deleted?: boolean } = {}) {
    return this.getItems<GlpiSoftware>('Software', options);
  }

  async getSoftware(id: number) {
    return this.getItem<GlpiSoftware>('Software', id);
  }

  async createSoftware(software: {
    name: string;
    comment?: string;
    locations_id?: number;
    users_id_tech?: number;
    groups_id_tech?: number;
    manufacturers_id?: number;
    softwarecategories_id?: number;
    entities_id?: number;
  }) {
    return this.createItem('Software', software);
  }

  // ==================== NETWORK EQUIPMENT ====================

  async getNetworkEquipments(options: { range?: string; is_deleted?: boolean } = {}) {
    return this.getItems<GlpiNetworkEquipment>('NetworkEquipment', options);
  }

  async getNetworkEquipment(id: number, options: { with_networkports?: boolean } = {}) {
    return this.getItem<GlpiNetworkEquipment>('NetworkEquipment', id, options);
  }

  async createNetworkEquipment(equipment: {
    name: string;
    serial?: string;
    otherserial?: string;
    locations_id?: number;
    networkequipmenttypes_id?: number;
    manufacturers_id?: number;
    entities_id?: number;
  }) {
    return this.createItem('NetworkEquipment', equipment);
  }

  // ==================== PRINTERS ====================

  async getPrinters(options: { range?: string; is_deleted?: boolean } = {}) {
    return this.getItems<GlpiPrinter>('Printer', options);
  }

  async getPrinter(id: number) {
    return this.getItem<GlpiPrinter>('Printer', id);
  }

  async createPrinter(printer: {
    name: string;
    serial?: string;
    locations_id?: number;
    printertypes_id?: number;
    manufacturers_id?: number;
    entities_id?: number;
  }) {
    return this.createItem('Printer', printer);
  }

  // ==================== MONITORS ====================

  async getMonitors(options: { range?: string; is_deleted?: boolean } = {}) {
    return this.getItems<GlpiMonitor>('Monitor', options);
  }

  async getMonitor(id: number) {
    return this.getItem<GlpiMonitor>('Monitor', id);
  }

  // ==================== PHONES ====================

  async getPhones(options: { range?: string; is_deleted?: boolean } = {}) {
    return this.getItems<GlpiPhone>('Phone', options);
  }

  async getPhone(id: number) {
    return this.getItem<GlpiPhone>('Phone', id);
  }

  // ==================== KNOWLEDGE BASE ====================

  async getKnowbaseItems(options: { range?: string } = {}) {
    return this.getItems<GlpiKnowbaseItem>('KnowbaseItem', options);
  }

  async getKnowbaseItem(id: number) {
    return this.getItem<GlpiKnowbaseItem>('KnowbaseItem', id);
  }

  async createKnowbaseItem(item: {
    name: string;
    answer: string;
    is_faq?: number;
    knowbaseitemcategories_id?: number;
  }) {
    return this.createItem('KnowbaseItem', item);
  }

  async searchKnowbase(query: string): Promise<GlpiKnowbaseItem[]> {
    await this.ensureSession();

    const response = await fetch(
      `${this.config.url}/apirest.php/search/KnowbaseItem?criteria[0][field]=6&criteria[0][searchtype]=contains&criteria[0][value]=${encodeURIComponent(query)}`,
      {
        method: 'GET',
        headers: this.getHeaders(),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to search knowbase: ${response.status}`);
    }

    const result = await response.json() as any;
    return result.data || [];
  }

  // ==================== CONTRACTS ====================

  async getContracts(options: { range?: string } = {}) {
    return this.getItems<GlpiContract>('Contract', options);
  }

  async getContract(id: number) {
    return this.getItem<GlpiContract>('Contract', id);
  }

  async createContract(contract: {
    name: string;
    num?: string;
    contracttypes_id?: number;
    begin_date?: string;
    duration?: number;
    notice?: number;
    comment?: string;
    entities_id?: number;
  }) {
    return this.createItem('Contract', contract);
  }

  // ==================== SUPPLIERS ====================

  async getSuppliers(options: { range?: string } = {}) {
    return this.getItems<GlpiSupplier>('Supplier', options);
  }

  async getSupplier(id: number) {
    return this.getItem<GlpiSupplier>('Supplier', id);
  }

  async createSupplier(supplier: {
    name: string;
    suppliertypes_id?: number;
    address?: string;
    postcode?: string;
    town?: string;
    country?: string;
    website?: string;
    phonenumber?: string;
    email?: string;
    entities_id?: number;
  }) {
    return this.createItem('Supplier', supplier);
  }

  // ==================== LOCATIONS ====================

  async getLocations(options: { range?: string } = {}) {
    return this.getItems<GlpiLocation>('Location', options);
  }

  async getLocation(id: number) {
    return this.getItem<GlpiLocation>('Location', id);
  }

  async createLocation(location: {
    name: string;
    locations_id?: number;
    address?: string;
    postcode?: string;
    town?: string;
    country?: string;
    building?: string;
    room?: string;
    entities_id?: number;
  }) {
    return this.createItem('Location', location);
  }

  // ==================== ENTITIES ====================

  async getEntities(options: { range?: string } = {}) {
    return this.getItems<GlpiEntity>('Entity', options);
  }

  async getEntity(id: number) {
    return this.getItem<GlpiEntity>('Entity', id);
  }

  // ==================== PROJECTS ====================

  async getProjects(options: { range?: string } = {}) {
    return this.getItems<GlpiProject>('Project', options);
  }

  async getProject(id: number) {
    return this.getItem<GlpiProject>('Project', id);
  }

  async createProject(project: {
    name: string;
    code?: string;
    content?: string;
    comment?: string;
    priority?: number;
    plan_start_date?: string;
    plan_end_date?: string;
    projectstates_id?: number;
    projecttypes_id?: number;
    users_id?: number;
    groups_id?: number;
    entities_id?: number;
  }) {
    return this.createItem('Project', project);
  }

  async updateProject(id: number, updates: Partial<GlpiProject>) {
    return this.updateItem('Project', id, updates);
  }

  // ==================== DOCUMENTS ====================

  async getDocuments(options: { range?: string } = {}) {
    return this.getItems<GlpiDocument>('Document', options);
  }

  async getDocument(id: number) {
    return this.getItem<GlpiDocument>('Document', id);
  }

  // ==================== CATEGORIES ====================

  async getCategories(options: { range?: string } = {}) {
    return this.getItems<GlpiCategory>('ITILCategory', options);
  }

  // ==================== SEARCH ====================

  async search(itemtype: string, criteria: Array<{
    field: number;
    searchtype: 'contains' | 'equals' | 'notequals' | 'lessthan' | 'morethan' | 'under' | 'notunder';
    value: string;
    link?: 'AND' | 'OR';
  }>, options: { limit?: number } = {}): Promise<any> {
    await this.ensureSession();

    const params = new URLSearchParams();
    criteria.forEach((c, i) => {
      params.append(`criteria[${i}][field]`, c.field.toString());
      params.append(`criteria[${i}][searchtype]`, c.searchtype);
      params.append(`criteria[${i}][value]`, c.value);
      if (c.link && i > 0) {
        params.append(`criteria[${i}][link]`, c.link);
      }
    });

    // Aplica range para limitar o tamanho da resposta (padrão: 20 itens)
    const limit = options.limit || 20;
    params.append('range', `0-${limit - 1}`);

    const response = await fetch(
      `${this.config.url}/apirest.php/search/${itemtype}?${params.toString()}`,
      {
        method: 'GET',
        headers: this.getHeaders(),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to search ${itemtype}: ${response.status}`);
    }

    return response.json();
  }

  // ==================== STATISTICS ====================

  async getTicketStats(): Promise<{
    total: number;
    new: number;
    processing: number;
    pending: number;
    solved: number;
    closed: number;
  }> {
    await this.ensureSession();

    // Usa a API de search com range=0-0 para obter apenas o totalcount por status,
    // sem transferir dados dos tickets. Corrige bug em ambientes com >10.000 tickets,
    // onde a abordagem anterior (range 0-9999) retornava apenas os tickets mais antigos
    // (todos fechados), zerando as contagens de new/processing/pending/solved.
    const countByStatus = async (status: number): Promise<number> => {
      const params = new URLSearchParams();
      params.append('criteria[0][field]', '12'); // campo 12 = status no GLPI
      params.append('criteria[0][searchtype]', 'equals');
      params.append('criteria[0][value]', status.toString());
      params.append('range', '0-0');
      const response = await fetch(
        `${this.config.url}/apirest.php/search/Ticket?${params.toString()}`,
        { method: 'GET', headers: this.getHeaders() }
      );
      if (!response.ok) return 0;
      const data = await response.json();
      return data.totalcount || 0;
    };

    const [newCount, assignedCount, plannedCount, pendingCount, solvedCount, closedCount] =
      await Promise.all([
        countByStatus(1), // New
        countByStatus(2), // Processing (assigned)
        countByStatus(3), // Processing (planned)
        countByStatus(4), // Pending
        countByStatus(5), // Solved
        countByStatus(6), // Closed
      ]);

    return {
      total: newCount + assignedCount + plannedCount + pendingCount + solvedCount + closedCount,
      new: newCount,
      processing: assignedCount + plannedCount,
      pending: pendingCount,
      solved: solvedCount,
      closed: closedCount,
    };
  }

  async getAssetStats(): Promise<{
    computers: number;
    monitors: number;
    printers: number;
    networkEquipments: number;
    phones: number;
    softwares: number;
  }> {
    await this.ensureSession();

    const [computers, monitors, printers, networkEquipments, phones, softwares] = await Promise.all([
      this.getComputers({ range: '0-9999', is_deleted: false }),
      this.getMonitors({ range: '0-9999', is_deleted: false }),
      this.getPrinters({ range: '0-9999', is_deleted: false }),
      this.getNetworkEquipments({ range: '0-9999', is_deleted: false }),
      this.getPhones({ range: '0-9999', is_deleted: false }),
      this.getSoftwares({ range: '0-9999', is_deleted: false }),
    ]);

    return {
      computers: computers.length,
      monitors: monitors.length,
      printers: printers.length,
      networkEquipments: networkEquipments.length,
      phones: phones.length,
      softwares: softwares.length,
    };
  }

  // ==================== SESSION INFO ====================

  async getMyProfiles(): Promise<any[]> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/getMyProfiles`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get profiles: ${response.status}`);
    }

    return response.json() as Promise<any[]>;
  }

  async getActiveProfile(): Promise<any> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/getActiveProfile`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get active profile: ${response.status}`);
    }

    return response.json();
  }

  async getMyEntities(): Promise<any[]> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/getMyEntities`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get entities: ${response.status}`);
    }

    return response.json() as Promise<any[]>;
  }

  async getFullSession(): Promise<any> {
    await this.ensureSession();

    const response = await fetch(`${this.config.url}/apirest.php/getFullSession`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.status}`);
    }

    return response.json();
  }
}
