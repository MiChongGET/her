import { join, resolve } from 'node:path'

/** Directory under the platform user-data folder that holds everything Her-Pi owns. The old Her stored its files directly in the user-data folder, so this must never be that folder. */
export const DATA_ROOT_NAME = 'Her-Pi-v1'

export interface DataPaths {
  /** Root of all Her-Pi data. */
  root: string
  database: string
  /** Pi session files and the working directories handed to Pi. */
  pi: string
  artifacts: string
  documents: string
}

/** The one place that decides where data lives; nothing else joins these names. */
export function dataPaths(userData: string): DataPaths {
  const root = join(resolve(userData), DATA_ROOT_NAME)
  return { root, database: join(root, 'her.sqlite'), pi: join(root, 'pi'), artifacts: join(root, 'artifacts'), documents: join(root, 'documents') }
}
