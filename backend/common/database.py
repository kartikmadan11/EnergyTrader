from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import DATA_DIR, DATABASE_URL

DATA_DIR.mkdir(parents=True, exist_ok=True)

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


# Set WAL mode and busy_timeout on every new raw sqlite3 connection created by
# aiosqlite. PRAGMA journal_mode=WAL must run *outside* a transaction, so we
# use the low-level sync connect event rather than engine.begin().
@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=120000")  # 2-minute wait for write locks
    cursor.close()


def _create_schema(conn) -> None:
    Base.metadata.create_all(conn)
    # create_all skips tables that already exist, so add indexes declared after a table was
    # first created.
    for table in Base.metadata.sorted_tables:
        for index in table.indexes:
            index.create(conn, checkfirst=True)


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(_create_schema)


async def get_db() -> AsyncSession:
    async with async_session() as session:
        yield session
