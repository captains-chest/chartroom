/** The small slice of Home Assistant's frontend `hass` object that Chartroom reads. */
export interface FloorEntry {
  floor_id: string;
  name: string;
  level: number | null;
}

export interface AreaEntry {
  area_id: string;
  name: string;
  floor_id: string | null;
}

export interface EntityEntry {
  entity_id: string;
  area_id?: string | null;
  device_id?: string | null;
  name?: string | null;
  hidden?: boolean;
  entity_category?: string | null;
}

export interface DeviceEntry {
  id: string;
  area_id?: string | null;
}

export interface EntityState {
  entity_id: string;
  state: string;
  attributes: { friendly_name?: string; device_class?: string; unit_of_measurement?: string };
  last_changed?: string;
}

export interface HassConnection {
  sendMessagePromise<T>(message: { type: string; [key: string]: unknown }): Promise<T>;
}

export interface Hass {
  floors?: Record<string, FloorEntry>;
  areas?: Record<string, AreaEntry>;
  /** The entity and device registries (display entries) and current states. */
  entities?: Record<string, EntityEntry>;
  devices?: Record<string, DeviceEntry>;
  states?: Record<string, EntityState>;
  connection?: HassConnection;
  user?: { is_admin: boolean };
  callService?: (
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
  ) => Promise<unknown>;
  /** fetch() with the user's access token, for the integration's HTTP views. */
  fetchWithAuth?: (path: string, init?: RequestInit) => Promise<Response>;
}

export interface PlanSummary {
  id: string;
  name: string;
  floor_id: string | null;
}
