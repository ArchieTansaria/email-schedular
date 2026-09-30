export const SERVICE_NAME = 'reachinbox-scheduler' as const;

export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
}

export function createHealthResponse(): HealthResponse {
  return {
    status: 'ok',
    service: SERVICE_NAME,
  };
}
