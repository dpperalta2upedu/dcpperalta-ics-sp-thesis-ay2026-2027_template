from pydantic import BaseModel


class SearchResponse(BaseModel):
    reply: str
