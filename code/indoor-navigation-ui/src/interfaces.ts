// Set of interfaces for type checking

export interface User {
    _id?: string;
    lastname: string;
    firstname: string;
    username: string;
}

export interface Map {
    _id?: string;
    mapid: string;
    mapname: string;
}

export interface TopNavBarProps {
    onMapSelect: (mapId: string) => void;
    user: User | null;
    onLogin: (userData: User) => void;
    onLogout: () => void;
}

export interface LoginProps {
    user: User | null;
    onLogin: (userData: User) => void;
    onLogout: () => void;
}

export interface MapSelectorProps {
    onMapSelect: (mapId: string) => void;
}

export interface MainMapProps {
    mapId: string;
}