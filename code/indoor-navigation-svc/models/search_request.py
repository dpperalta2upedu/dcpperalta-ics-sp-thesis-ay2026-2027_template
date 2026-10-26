from pydantic import BaseModel


class SearchRequest(BaseModel):
    origin: str | None = None
    destination: str | None = None
