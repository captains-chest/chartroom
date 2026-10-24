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

export interface HassConnection {
  sendMessagePromise<T>(message: { type: string; [key: string]: unknown }): Promise<T>;
}

export interface Hass {
  floors?: Record<string, FloorEntry>;
  areas?: Record<string, AreaEntry>;
  connection?: HassConnection;
}
