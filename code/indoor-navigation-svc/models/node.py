from typing import Dict, Optional
from dataclasses import dataclass, field

@dataclass
class Node:
    """
    Represents a single location (node) in the navigation graph.
    
    A node can represent various locations such as entrances, stores, hallways,
    staircases, or elevators. Each node has a unique ID, coordinates, and optional
    metadata for additional information.
    
    Attributes:
        id (str): Unique identifier for the node (e.g., "store_l1", "center_hall_1")
        x (float): X-coordinate position on the floor plan
        y (float): Y-coordinate position on the floor plan
        floor (int): Floor number (default: 1). Used for multi-floor navigation
        name (str, optional): Human-readable name (e.g., "Coffee Shop", "Main Staircase")
        type (str, optional): Category of node. Common types:
            - "hallway": Corridor or passage
            - "store": Commercial establishment
            - "stair": Staircase
            - "elevator": Elevator
            - "entrance": Building entrance
            - "exit": Building exit
        metadata (dict): Additional custom data as key-value pairs
    
    Example:
        >>> node = Node(
        ...     id="store_electronics",
        ...     x=350,
        ...     y=80,
        ...     floor=2,
        ...     name="Electronics Store",
        ...     type="store",
        ...     metadata={"hours": "9AM-9PM", "phone": "555-1234"}
        ... )
    """
    id: str
    x: float
    y: float
    floor: int = 1
    wing: Optional[str] = None
    name: Optional[str] = None
    type: Optional[str] = None  # "hallway", "room", "stair", "elevator", etc.
    metadata: Dict = field(default_factory=dict)
    width: Optional[float] = None
    height: Optional[float] = None
    
    @property
    def center(self):
        if self.width is not None and self.height is not None:
            return (
                self.x + self.width / 2,
                self.y + self.height / 2
            )
        return (self.x, self.y)
    

    def __init__(
            self,
            id,
            x,
            y,
            width=None,
            height=None,
            floor=1,
            wing=None,
            name=None,
            type=None,
            metadata=None,
        ):
            self.id = id
            self.x = x
            self.y = y
            self.width = width
            self.height = height
            self.floor = floor
            self.wing = wing
            self.name = name
            self.type = type
            self.metadata = metadata or {}

    def to_dict(self) -> Dict:
        """
        Convert node to dictionary representation suitable for JSON serialization.
        
        Returns only non-empty fields to keep JSON compact. Always includes id, x, y, and floor.
        Optional fields (name, type, metadata) are only included if they have values.
        
        Returns:
            Dict: Dictionary representation with keys: id, x, y, floor, and optionally
                  name, type, metadata
        
        Example:
            >>> node = Node("store_1", 100, 200, floor=2, name="Shop", type="store")
            >>> node.to_dict()
            {'id': 'store_1', 'x': 100, 'y': 200, 'floor': 2, 'name': 'Shop', 'type': 'store'}
        """
        data = {"id": self.id, "x": self.x, "y": self.y, "floor": self.floor}
        if self.width is not None:
            data["width"] = self.width
        if self.height is not None:
            data["height"] = self.height
        if self.wing:
            data["wing"] = self.wing
        if self.name:
            data["name"] = self.name
        if self.type:
            data["type"] = self.type
        if self.metadata:
            data["metadata"] = self.metadata
        return data
