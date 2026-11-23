function createDB() {
    throw new Error('CoCreateDB browser storage is not implemented yet')
}

createDB.init = createDB

export { createDB, createDB as init }
export default createDB
