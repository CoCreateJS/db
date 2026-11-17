/********************************************************************************
 * Copyright (C) 2023-2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 ********************************************************************************/

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://CoCreateJS.com/licenses/> or contact us at sales@CoCreateJS.com.

import createIndex from './index/index.js'
export { resolveDirectory } from './directory.js'
import { createDistributionIndex } from './distribution.js'
import { createDB } from './scoped.js'
import { CoCreateDB, DB_PROVIDER, init, initLocal, initializeServerDB } from './server.js'
export { getPersistence, sendPersistence, getPersistenceDriver, registerPersistenceDriver, persistenceDrivers } from './persistence/index.js'

export { createIndex, createDistributionIndex, createDB, CoCreateDB, init, initLocal, initializeServerDB, DB_PROVIDER }
export default createIndex
